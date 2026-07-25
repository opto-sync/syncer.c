import { BaseMergeStrategy } from '../../../bindings/typescript/BaseMergeStrategy';
import { mergeJson, MergeOptions } from '../../../bindings/typescript';

/**
 * Merge options a plugin caller may tune. The override callback is always
 * derived from the strategy, so it is not part of the public surface.
 */
export type SyncerMergeOptions = Omit<MergeOptions, 'overrideCb'>;

/* Column names are interpolated as SQL identifiers (they cannot be bound as
   parameters), so they must be plain identifiers — anything else is rejected
   before it reaches the query builder. */
const SAFE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * A TypeORM ValueTransformer for JSONB columns.
 * While TypeORM normally calls this on every read/write,
 * this transformer can store the strategy to be used by a custom repository method.
 */
export function SyncerJsonbTransformer<T>(strategy: BaseMergeStrategy<T>) {
  return {
    to: (value: T) => {
      return value; // TypeORM handles JSON stringification internally usually
    },
    from: (value: any) => {
      return value;
    }
  };
}

/**
 * TypeORM utility for zero-deserialization merge.
 * Requires querying the DB using QueryBuilder to get the raw string.
 *
 * @param options Optional merge tuning (arrayStrategy incl. MERGE_BY_KEY,
 *                arrayMatchKeys, maxDepth, detectCircularRefs,
 *                resolveByTimestamp, lwwKeys, fwwKeys) forwarded to the C core.
 */
export async function typeOrmSyncMerge<T>(
  repository: any,
  id: string | number,
  columnName: string,
  incomingRawJson: string,
  strategy: BaseMergeStrategy<T>,
  options?: SyncerMergeOptions
): Promise<void> {
  if (!SAFE_IDENTIFIER.test(columnName)) {
    throw new Error(`opto-sync: unsafe column name ${JSON.stringify(columnName)}`);
  }

  // 1. Query raw string
  const rawResult = await repository
    .createQueryBuilder('entity')
    .select(`entity.${columnName}::text`, 'raw_json')
    .where('entity.id = :id', { id })
    .getRawOne();

  const currentRawJson = rawResult ? rawResult.raw_json : '{}';

  // 2. Merge in C
  const mergedString = mergeJson(currentRawJson, incomingRawJson, {
    ...options,
    overrideCb: strategy.toNativeCallback(),
  });
  if (mergedString === null) {
    throw new Error('opto-sync merge failed: input was not valid JSON');
  }

  // 3. Update using raw string (bypassing object creation entirely).
  //    The merged JSON travels as a BOUND PARAMETER — interpolating it into
  //    the SQL text breaks on any quote in the data and is injectable when
  //    the JSON content is attacker-controlled.
  await repository
    .createQueryBuilder()
    .update()
    .set({
      [columnName]: () => 'CAST(:mergedJson AS jsonb)'
    })
    .setParameter('mergedJson', mergedString)
    .where('id = :id', { id })
    .execute();
}
