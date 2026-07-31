/**
 * REAL integration test for the Drizzle plugin.
 *
 * Uses the actual `drizzle-orm` package (drizzle-orm/node-postgres + pg) against
 * a real Postgres table with a real `jsonb` column. Nothing is stubbed.
 */
import { drizzle, NodePgDatabase } from 'drizzle-orm/node-postgres';
import { pgTable, text } from 'drizzle-orm/pg-core';
import { eq, sql } from 'drizzle-orm';
import { Pool } from 'pg';

import { syncedJsonb, performZeroDeserializationMerge } from '../drizzle';
import {
  POLICY,
  FWW_POLICY,
  BASE_DOC,
  INCOMING_RAW,
  EXPECTED_MERGED,
  EXPECTED_MERGED_FWW,
  EXPECTED_MERGED_WITH_OVERRIDE,
  PassthroughStrategy,
  OverrideStrategy,
} from './fixtures';
import {
  suite,
  test,
  ok,
  deepEqual,
  equal,
  rejects,
  stable,
  readPersisted,
  resetTable,
  seed,
  CONN,
} from './harness';

const TABLE = 'drizzle_docs';

type Doc = typeof BASE_DOC;

/* The plugin's column-type surface: syncedJsonb() must produce a genuine jsonb
   column that round-trips through the real pg driver. */
const docs = pgTable(TABLE, {
  id: text('id').primaryKey(),
  doc: syncedJsonb<Doc>('doc', new PassthroughStrategy()),
  label: text('label'),
});

let pool: Pool;
let db: NodePgDatabase;

export async function register() {
  suite('drizzle-orm (REAL package, real Postgres jsonb)');

  pool = new Pool({ connectionString: CONN, max: 4 });
  db = drizzle(pool);

  test('syncedJsonb declares a real jsonb column (dataType)', async () => {
    await resetTable(TABLE);
    const r = await pool.query(
      `select data_type from information_schema.columns
       where table_name = $1 and column_name = 'doc'`,
      [TABLE],
    );
    equal(r.rows[0]?.data_type, 'jsonb', 'doc column is jsonb in the catalog');
  });

  test('syncedJsonb round-trips an object through the real pg driver', async () => {
    await resetTable(TABLE);
    // toDriver: object -> text parameter -> Postgres casts to jsonb
    await db.insert(docs).values({ id: 'rt', doc: BASE_DOC, label: 'x' });

    // fromDriver: pg hands back an ALREADY-PARSED object for jsonb. The old
    // implementation did JSON.parse(object) and threw here.
    const rows = await db.select().from(docs).where(eq(docs.id, 'rt'));
    equal(rows.length, 1, 'one row selected via drizzle');
    deepEqual(rows[0].doc, BASE_DOC, 'fromDriver returned the document unmangled');
    ok(typeof rows[0].doc === 'object' && rows[0].doc !== null, 'doc is an object, not text');

    // and it really landed in the DB as jsonb, verified out-of-band
    deepEqual(await readPersisted(TABLE, 'id', 'rt', 'doc'), BASE_DOC, 'persisted via drizzle insert');
  });

  test('syncedJsonb toDriver passes a raw JSON string through un-double-encoded', async () => {
    await resetTable(TABLE);
    const raw = JSON.stringify(BASE_DOC);
    // The zero-deserialization path yields a STRING; it must be stored as the
    // document, not as a JSON string literal.
    await db.insert(docs).values({ id: 'zd', doc: raw as unknown as Doc });
    const persisted = await readPersisted(TABLE, 'id', 'zd', 'doc');
    deepEqual(persisted, BASE_DOC, 'raw string stored as a document, not as a quoted string');
    ok(typeof persisted === 'object', 'stored jsonb is an object, not a string scalar');
  });

  test('performZeroDeserializationMerge reconciles per the canonical policy', async () => {
    const merged = performZeroDeserializationMerge<Doc>(
      JSON.stringify(BASE_DOC),
      INCOMING_RAW,
      new PassthroughStrategy(),
      POLICY,
    );
    deepEqual(merged, EXPECTED_MERGED, 'in-memory merge matches the canonical expectation');
  });

  test('end-to-end: read jsonb, merge, write back, and it PERSISTS', async () => {
    await resetTable(TABLE);
    await seed(TABLE, 'e2e', BASE_DOC);

    // 1. read the stored document as RAW TEXT via drizzle (zero-deserialization)
    const rawRows = await db
      .select({ raw: sql<string>`${docs.doc}::text` })
      .from(docs)
      .where(eq(docs.id, 'e2e'));
    equal(typeof rawRows[0].raw, 'string', 'drizzle returned the jsonb as raw text');

    // 2. merge through the plugin
    const merged = performZeroDeserializationMerge<Doc>(
      rawRows[0].raw,
      INCOMING_RAW,
      new PassthroughStrategy(),
      POLICY,
    );

    // 3. write back through drizzle's own update (toDriver)
    await db.update(docs).set({ doc: merged }).where(eq(docs.id, 'e2e'));

    // 4. re-read on an INDEPENDENT raw connection: an in-memory-only merge fails here
    const persisted = await readPersisted(TABLE, 'id', 'e2e', 'doc');
    deepEqual(persisted, EXPECTED_MERGED, 'merged document PERSISTED to jsonb');

    // targeted reconciliation assertions on the persisted value
    equal(persisted.profile.name, 'Ada', 'deep merge preserved profile.name');
    equal(persisted.profile.theme.mode, 'dark', 'deep merge preserved theme.mode');
    equal(persisted.profile.theme.accent, 'red', 'deep merge applied theme.accent');
    equal(persisted.profile.locale, 'en-GB', 'deep merge added profile.locale');

    const byId = Object.fromEntries(persisted.items.map((i: any) => [i.id, i]));
    equal(byId.a.qty, 1, 'STALE array element id=a REJECTED (qty unchanged)');
    equal(byId.a.note, 'base-a', 'STALE array element id=a REJECTED (note unchanged)');
    equal(byId.b.qty, 42, 'FRESH sibling id=b APPLIED in the same array');
    equal(byId.c.qty, 7, 'NEW element id=c APPENDED');
    equal(persisted.items.length, 3, 'array has exactly 3 elements (no duplicate a/b)');
    equal(persisted.items[2].id, 'c', 'new element appended at the END');

    equal(persisted.audit.createdAt, '2030-01-01T00:00:00Z', 'no default FWW: audit deep-merges');
    equal(persisted.audit.actor, 'impostor', 'no default FWW: the incoming actor lands');
  });

  test('createdAt FWW rejects a re-creation when opted into explicitly (persisted)', async () => {
    await resetTable(TABLE);
    await seed(TABLE, 'fww', BASE_DOC);
    const rows = await db
      .select({ raw: sql<string>`${docs.doc}::text` })
      .from(docs)
      .where(eq(docs.id, 'fww'));
    const merged = performZeroDeserializationMerge<Doc>(
      rows[0].raw,
      INCOMING_RAW,
      new PassthroughStrategy(),
      FWW_POLICY,
    );
    await db.update(docs).set({ doc: merged }).where(eq(docs.id, 'fww'));

    const persisted = await readPersisted(TABLE, 'id', 'fww', 'doc');
    deepEqual(persisted, EXPECTED_MERGED_FWW, 'explicit FWW vetoes the audit subtree wholesale');
    equal(persisted.audit.createdAt, '2026-01-01T00:00:00Z', 'original createdAt retained');
    equal(persisted.audit.actor, 'original-owner', 'impostor rejected WITH the whole subtree');
  });

  test('REGRESSION: a default createdAt FWW key would veto the newest write', async () => {
    // FWW is a NODE-LEVEL veto, not field protection: the incoming node below is
    // the newest write in the system by updatedAt, by an enormous margin, and
    // FWW still drops it wholesale. A replica holding a later createdAt would
    // therefore be permanently, silently unable to write the record — which is
    // why createdAt is not in any default policy.
    const base = JSON.stringify({ createdAt: 100, updatedAt: 100, v: 'base' });
    const incoming = JSON.stringify({ createdAt: 200, updatedAt: 999999, v: 'NEWEST' });

    const underDefault = performZeroDeserializationMerge<any>(
      base, incoming, new PassthroughStrategy(), POLICY,
    );
    equal(underDefault.v, 'NEWEST', 'default policy lets the newest write land');

    const underFww = performZeroDeserializationMerge<any>(
      base, incoming, new PassthroughStrategy(), FWW_POLICY,
    );
    equal(underFww.v, 'base', 'explicit FWW vetoes the node despite the newer updatedAt');
    equal(underFww.updatedAt, 100, 'the newest updatedAt is discarded with the node');
  });

  test('repeated apply is semantically idempotent (parsed compare, not raw text)', async () => {
    await resetTable(TABLE);
    await seed(TABLE, 'idem', BASE_DOC);

    const applyOnce = async () => {
      const rows = await db
        .select({ raw: sql<string>`${docs.doc}::text` })
        .from(docs)
        .where(eq(docs.id, 'idem'));
      const merged = performZeroDeserializationMerge<Doc>(
        rows[0].raw,
        INCOMING_RAW,
        new PassthroughStrategy(),
        POLICY,
      );
      await db.update(docs).set({ doc: merged }).where(eq(docs.id, 'idem'));
    };

    await applyOnce();
    const after1 = await readPersisted(TABLE, 'id', 'idem', 'doc');
    await applyOnce();
    const after2 = await readPersisted(TABLE, 'id', 'idem', 'doc');
    await applyOnce();
    const after3 = await readPersisted(TABLE, 'id', 'idem', 'doc');

    // Postgres jsonb reorders object keys, so compare PARSED values.
    deepEqual(after2, after1, 'second apply changed nothing');
    deepEqual(after3, after1, 'third apply changed nothing');
    equal(stable(after1), stable(EXPECTED_MERGED), 'converged on the expected document');
    equal(after3.items.length, 3, 'idempotent apply did not grow the keyed array');
  });

  test('custom strategy override reaches the C core and its result PERSISTS', async () => {
    await resetTable(TABLE);
    await seed(TABLE, 'ov', BASE_DOC);

    const strategy = new OverrideStrategy();
    const rows = await db
      .select({ raw: sql<string>`${docs.doc}::text` })
      .from(docs)
      .where(eq(docs.id, 'ov'));
    const merged = performZeroDeserializationMerge<Doc>(rows[0].raw, INCOMING_RAW, strategy, POLICY);
    await db.update(docs).set({ doc: merged }).where(eq(docs.id, 'ov'));

    ok(strategy.calls.length > 0, 'handleConflict was invoked by the native core');
    ok(strategy.calls.includes('accent'), 'override saw the nested scalar key "accent"');
    ok(strategy.calls.includes('qty'), 'override saw a key INSIDE a keyed-array element');

    const persisted = await readPersisted(TABLE, 'id', 'ov', 'doc');
    equal(
      persisted.profile.theme.accent,
      'override(blue->red)',
      'override return value persisted for a nested scalar',
    );
    const b = persisted.items.find((i: any) => i.id === 'b');
    equal(b.qty, 44, 'override summed qty inside the merged array element (2+42)');
    const a = persisted.items.find((i: any) => i.id === 'a');
    equal(a.qty, 1, 'override never ran for the stale element, which stayed rejected');
    deepEqual(persisted, EXPECTED_MERGED_WITH_OVERRIDE, 'full overridden document persisted');
  });

  test('options are genuinely forwarded: REPLACE vs MERGE_BY_KEY differ', async () => {
    const withKey = performZeroDeserializationMerge<any>(
      JSON.stringify(BASE_DOC),
      INCOMING_RAW,
      new PassthroughStrategy(),
      POLICY,
    );
    const withReplace = performZeroDeserializationMerge<any>(
      JSON.stringify(BASE_DOC),
      INCOMING_RAW,
      new PassthroughStrategy(),
      { arrayStrategy: 0 },
    );
    equal(withKey.items.length, 3, 'MERGE_BY_KEY reconciled to 3 elements');
    equal(withReplace.items.length, 3, 'REPLACE took the incoming array verbatim');
    equal(
      withReplace.items.find((i: any) => i.id === 'a').qty,
      999,
      'without the policy the STALE element wins — proves options change behaviour',
    );
    equal(
      withKey.items.find((i: any) => i.id === 'a').qty,
      1,
      'with the policy forwarded the STALE element is rejected',
    );
    // arrayMatchKeys must be forwarded too
    const alt = performZeroDeserializationMerge<any>(
      JSON.stringify({ rows: [{ sku: 'x', v: 1 }] }),
      JSON.stringify({ rows: [{ sku: 'x', v: 2 }] }),
      new PassthroughStrategy(),
      { arrayStrategy: 4, arrayMatchKeys: 'sku' },
    );
    equal(alt.rows.length, 1, 'arrayMatchKeys forwarded: matched on "sku" instead of "id"');
    equal(alt.rows[0].v, 2, 'matched element deep-merged');
  });

  test('invalid JSON surfaces as a thrown error, not a null return', async () => {
    await rejects(
      async () =>
        performZeroDeserializationMerge<any>(
          '{ not valid json',
          INCOMING_RAW,
          new PassthroughStrategy(),
          POLICY,
        ),
      /was not valid JSON/,
      'null from the core is converted to a descriptive throw',
    );
  });
}

export async function teardown() {
  await pool?.end();
}
