import { BaseMergeStrategy } from '../../../bindings/typescript/BaseMergeStrategy';
import { mergeJson } from '../../../bindings/typescript';
import { Kysely, sql } from 'kysely';

/**
 * Kysely utility for zero-deserialization sync.
 * Kysely's pure SQL builder nature makes it the most efficient 
 * for our Zero-Deserialization architecture.
 */
export async function kyselySyncJsonb<DB, TableName extends keyof DB, T>(
  db: Kysely<DB>,
  table: TableName,
  idColumn: keyof DB[TableName],
  idValue: any,
  jsonColumn: keyof DB[TableName],
  incomingRawJson: string,
  strategy: BaseMergeStrategy<T>
) {
  // 1. Fetch raw string using sql`` tagged template
  const rawQuery = await db
    .selectFrom(table)
    .select(sql<string>`${sql.ref(jsonColumn as string)}::text`.as('raw_json'))
    .where(idColumn as any, '=', idValue)
    .executeTakeFirst();

  const currentRawJson = rawQuery ? rawQuery.raw_json : '{}';

  // 2. Merge via C FFI
  const mergedString = mergeJson(currentRawJson, incomingRawJson, strategy.handleConflict.bind(strategy));

  // 3. Save raw string directly back as JSONB
  await db
    .updateTable(table)
    .set({
      [jsonColumn]: sql`CAST(${mergedString} AS jsonb)`
    } as any)
    .where(idColumn as any, '=', idValue)
    .execute();
    
  return mergedString;
}
