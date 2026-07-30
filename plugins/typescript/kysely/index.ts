import { BaseMergeStrategy } from '../../../bindings/typescript/BaseMergeStrategy';
import { mergeJson, MergeOptions } from '../../../bindings/typescript';
import { Kysely, Transaction, sql } from 'kysely';

/**
 * Merge options a plugin caller may tune. The override callback is always
 * derived from the strategy, so it is not part of the public surface.
 */
export type SyncerMergeOptions = Omit<MergeOptions, 'overrideCb'>;

/** Thrown when the target row does not exist, so nothing could be merged. */
export class SyncerRowNotFoundError extends Error {
  constructor(table: string, idColumn: string, idValue: unknown) {
    super(
      `opto-sync: no row in "${table}" where "${idColumn}" = ${JSON.stringify(idValue)} — ` +
        `nothing was merged or written. Insert the row first, or catch ` +
        `SyncerRowNotFoundError and fall back to an insert.`,
    );
    this.name = 'SyncerRowNotFoundError';
  }
}

/**
 * Kysely utility for zero-deserialization sync.
 * Kysely's pure SQL builder nature makes it the most efficient
 * for our Zero-Deserialization architecture.
 *
 * Read-modify-write safety: the SELECT and the UPDATE run inside ONE
 * transaction and the row is locked with `FOR UPDATE`, so two concurrent syncs
 * of the same row serialize instead of one silently losing the other's merge.
 * When `db` is already a transaction it is reused (the lock then lasts until the
 * caller's transaction commits); otherwise a transaction is opened for the
 * duration of this call.
 *
 * @param options Optional merge tuning (arrayStrategy incl. MERGE_BY_KEY,
 *                arrayMatchKeys, maxDepth, detectCircularRefs,
 *                resolveByTimestamp, lwwKeys, fwwKeys) forwarded to the C core.
 * @returns the merged JSON string that was persisted.
 * @throws SyncerRowNotFoundError when no row matches `idColumn = idValue`.
 */
export async function kyselySyncJsonb<DB, TableName extends keyof DB & string, T>(
  db: Kysely<DB> | Transaction<DB>,
  table: TableName,
  idColumn: keyof DB[TableName] & string,
  idValue: any,
  jsonColumn: keyof DB[TableName] & string,
  incomingRawJson: string,
  strategy: BaseMergeStrategy<T>,
  options?: SyncerMergeOptions
): Promise<string> {
  const run = async (trx: Kysely<DB> | Transaction<DB>): Promise<string> => {
    // 1. Fetch raw text and lock the row. A typed raw builder is used here
    // because Kysely 0.29 intentionally rejects method chaining through a
    // runtime-generic table/column union. Identifiers remain identifier nodes
    // and values remain bound parameters.
    const selected = await sql<{ raw_json: string | null }>`
      SELECT ${sql.ref(jsonColumn)}::text AS raw_json
      FROM ${sql.table(table)}
      WHERE ${sql.ref(idColumn)} = ${idValue}
      FOR UPDATE
    `.execute(trx);
    const rawQuery = selected.rows[0];

    // A missing row used to fall back to '{}' and then issue an UPDATE that
    // matched zero rows, so the caller received a merged string back and
    // believed it had been saved. Fail loudly instead.
    if (!rawQuery) throw new SyncerRowNotFoundError(table, idColumn, idValue);

    // A SQL NULL in the column means "empty document", not the string "null".
    const currentRawJson = rawQuery.raw_json ?? '{}';

    // 2. Merge via C FFI
    const mergedString = mergeJson(currentRawJson, incomingRawJson, {
      ...options,
      overrideCb: strategy.toNativeCallback(),
    });
    if (mergedString === null) {
      throw new Error('opto-sync merge failed: input was not valid JSON');
    }

    // 3. Save raw string directly back as JSONB. `mergedString` is interpolated
    //    into the sql`` template as a BOUND PARAMETER, never as SQL text.
    const updated = await sql<{ updated: number }>`
      UPDATE ${sql.table(table)}
      SET ${sql.ref(jsonColumn)} = CAST(${mergedString} AS jsonb)
      WHERE ${sql.ref(idColumn)} = ${idValue}
      RETURNING 1 AS updated
    `.execute(trx);

    if (updated.rows.length === 0) {
      throw new SyncerRowNotFoundError(table, idColumn, idValue);
    }

    return mergedString;
  };

  return db.isTransaction ? run(db) : db.transaction().execute(run);
}
