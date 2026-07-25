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

/** Thrown when the target row does not exist, so nothing could be merged. */
export class SyncerRowNotFoundError extends Error {
  constructor(idColumn: string, id: unknown) {
    super(
      `opto-sync: no row where "${idColumn}" = ${JSON.stringify(id)} — nothing was ` +
        `merged or written. Insert the row first, or catch SyncerRowNotFoundError ` +
        `and fall back to an insert.`,
    );
    this.name = 'SyncerRowNotFoundError';
  }
}

/**
 * TypeORM utility for zero-deserialization merge.
 * Requires querying the DB using QueryBuilder to get the raw string.
 *
 * Read-modify-write safety: the SELECT and the UPDATE run inside ONE
 * transaction and the row is locked with `pessimistic_write` (`FOR UPDATE`), so
 * two concurrent syncs of the same row serialize instead of one silently losing
 * the other's merge. When `repository` already belongs to a transactional
 * EntityManager, TypeORM reuses that transaction.
 *
 * @param idColumn Primary-key PROPERTY name used to locate the row. Defaults to
 *                 "id"; pass it explicitly for entities keyed differently.
 * @param options Optional merge tuning (arrayStrategy incl. MERGE_BY_KEY,
 *                arrayMatchKeys, maxDepth, detectCircularRefs,
 *                resolveByTimestamp, lwwKeys, fwwKeys) forwarded to the C core.
 * @returns the merged JSON string that was persisted.
 * @throws SyncerRowNotFoundError when no row matches `idColumn = id`.
 */
export async function typeOrmSyncMerge<T>(
  repository: any,
  id: string | number,
  columnName: string,
  incomingRawJson: string,
  strategy: BaseMergeStrategy<T>,
  options?: SyncerMergeOptions,
  idColumn: string = 'id'
): Promise<string> {
  if (!SAFE_IDENTIFIER.test(columnName)) {
    throw new Error(`opto-sync: unsafe column name ${JSON.stringify(columnName)}`);
  }
  if (!SAFE_IDENTIFIER.test(idColumn)) {
    throw new Error(`opto-sync: unsafe id column name ${JSON.stringify(idColumn)}`);
  }

  const target = repository.target ?? repository.metadata?.target;

  const run = async (manager: any): Promise<string> => {
    // 1. Query raw string, taking a row lock so a concurrent sync of the same
    //    row cannot interleave read-modify-write.
    const rawResult = await manager
      .createQueryBuilder(target, 'entity')
      .select(`entity.${columnName}::text`, 'raw_json')
      .where(`entity.${idColumn} = :id`, { id })
      .setLock('pessimistic_write')
      .getRawOne();

    // A missing row previously fell back to '{}' and then issued an UPDATE that
    // matched zero rows, so the caller believed the merge had been saved.
    if (!rawResult) throw new SyncerRowNotFoundError(idColumn, id);

    // A SQL NULL in the column is an empty document, not the string "null".
    const currentRawJson = rawResult.raw_json ?? '{}';

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
    const result = await manager
      .createQueryBuilder()
      .update(target)
      .set({
        [columnName]: () => 'CAST(:mergedJson AS jsonb)'
      })
      .setParameter('mergedJson', mergedString)
      .where(`${idColumn} = :id`, { id })
      .execute();

    if (result && result.affected === 0) {
      throw new SyncerRowNotFoundError(idColumn, id);
    }

    return mergedString;
  };

  // EntityManager.transaction() reuses an already-active transaction, so a
  // caller-managed transaction is joined rather than nested.
  return repository.manager.transaction(run);
}
