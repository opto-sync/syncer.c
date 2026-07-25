import { Prisma } from '@prisma/client/extension';
import { BaseMergeStrategy } from '../../../bindings/typescript/BaseMergeStrategy';
import { mergeJson, MergeOptions } from '../../../bindings/typescript';

/**
 * Merge options a plugin caller may tune. The override callback is always
 * derived from the strategy, so it is not part of the public surface.
 */
export type SyncerMergeOptions = Omit<MergeOptions, 'overrideCb'>;

/**
 * Creates a Prisma Client Extension that automatically merges JSONB fields
 * on conflicts or manual sync endpoints, using the opto-sync C library.
 *
 * @param options Optional merge tuning (arrayStrategy incl. MERGE_BY_KEY,
 *                arrayMatchKeys, maxDepth, detectCircularRefs,
 *                resolveByTimestamp, lwwKeys, fwwKeys) forwarded to the C core.
 */
export function withSyncer(
  modelName: string,
  fieldName: string,
  strategy: BaseMergeStrategy<any>,
  options?: SyncerMergeOptions,
  /**
   * How many times to retry when a concurrent writer wins the compare-and-set.
   * Each retry waits a jittered exponential backoff. Raise this if many writers
   * contend for the same row.
   */
  maxRetries: number = 10
) {
  return Prisma.defineExtension({
    name: 'opto-sync-syncer',
    model: {
      $allModels: {
        /**
         * Custom method added to Prisma models.
         * Usage: prisma.user.syncJsonField({ id: 1 }, rawIncomingJson)
         *
         * Concurrency: Prisma's model API cannot express `SELECT ... FOR UPDATE`,
         * so this uses optimistic concurrency instead. The write is an
         * `updateMany` whose WHERE also requires the JSON field to still equal
         * the value the merge was computed from (a compare-and-set). If another
         * writer committed in between, the CAS matches 0 rows and the whole
         * read-merge-write is retried, so no merge is silently lost.
         */
        async syncJsonField(this: any, where: any, incomingRawJson: string) {
          const context = Prisma.getExtensionContext(this) as any;

          // `$allModels` attaches this method to EVERY model, but `fieldName`
          // is fixed at configuration time. Calling it on a different model
          // would merge the wrong (or a non-existent) field, so refuse.
          const actualModel: string | undefined = context?.$name;
          if (
            typeof actualModel === 'string' &&
            actualModel.toLowerCase() !== modelName.toLowerCase()
          ) {
            throw new Error(
              `opto-sync: syncJsonField is configured for model "${modelName}" ` +
              `(field "${fieldName}") but was called on "${actualModel}". ` +
              `Apply a separate withSyncer() extension per model.`
            );
          }

          for (let attempt = 0; ; attempt++) {
            // 1. Fetch the current document.
            // Note: Prisma deserializes JSONB to a JS object, so the
            // zero-deserialization goal is not reachable through the model API;
            // this plugin trades that for Prisma-native ergonomics.
            const record = await context.findUnique({ where });
            if (record === null || record === undefined) {
              throw new Error(
                `opto-sync: cannot sync field "${fieldName}" — no ${modelName} record matches ` +
                `where ${JSON.stringify(where)} (findUnique returned null)`
              );
            }
            if (!(fieldName in record)) {
              // Without this, JSON.stringify(undefined) returns undefined (not a
              // string) and the native addon throws an opaque "String expected".
              throw new Error(
                `opto-sync: ${modelName} record has no field "${fieldName}" ` +
                `(available: ${Object.keys(record).join(', ')}). Check the ` +
                `withSyncer() fieldName, and do not use a "select" that omits it.`
              );
            }

            const current = record[fieldName];
            // A JSON null / absent value is an empty document, not the string "null".
            const currentRawJson =
              current === null || current === undefined ? '{}' : JSON.stringify(current);

            // 2. Perform native C merge
            const mergedRaw = mergeJson(currentRawJson, incomingRawJson, {
              ...options,
              overrideCb: strategy.toNativeCallback(),
            });
            if (mergedRaw === null) {
              throw new Error('opto-sync merge failed: input was not valid JSON');
            }

            // 3. Compare-and-set: only write if the row still holds `current`.
            const result = await context.updateMany({
              where: { ...where, [fieldName]: { equals: current === undefined ? null : current } },
              data: {
                [fieldName]: JSON.parse(mergedRaw) // Prisma requires a value, not raw SQL
              }
            });

            if (result.count > 0) {
              return context.findUnique({ where });
            }

            if (attempt >= maxRetries) {
              throw new Error(
                `opto-sync: gave up after ${maxRetries + 1} attempts merging "${fieldName}" on ` +
                `${modelName} where ${JSON.stringify(where)} — the row kept changing ` +
                `underneath (write contention). Raise maxRetries, or serialize ` +
                `writes to this row.`
              );
            }

            // A concurrent writer won. Back off with randomized (jittered)
            // exponential delay before re-merging onto their result: retrying
            // immediately makes N contending writers livelock, because they all
            // re-read and re-CAS in lockstep and keep invalidating each other.
            const backoffMs = Math.random() * Math.min(2 ** attempt, 32);
            await new Promise((resolve) => setTimeout(resolve, backoffMs));
          }
        }
      }
    }
  });
}
