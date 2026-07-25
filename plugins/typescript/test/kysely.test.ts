/**
 * REAL integration test for the Kysely plugin.
 *
 * Uses the actual `kysely` package with its PostgresDialect over `pg`, against a
 * real Postgres table with a real `jsonb` column. The plugin does the full
 * read-merge-write itself, so persistence is asserted directly.
 */
import { Kysely, PostgresDialect, sql } from 'kysely';
import { Pool } from 'pg';

import { kyselySyncJsonb, SyncerRowNotFoundError } from '../kysely';
import {
  POLICY,
  BASE_DOC,
  INCOMING_RAW,
  EXPECTED_MERGED,
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
  exec,
  CONN,
} from './harness';

const TABLE = 'kysely_docs';

interface DocRow {
  id: string;
  doc: unknown;
  label: string | null;
}
interface DB {
  kysely_docs: DocRow;
}

let db: Kysely<DB>;
let pool: Pool;

export async function register() {
  suite('kysely (REAL package, real Postgres jsonb)');

  pool = new Pool({ connectionString: CONN, max: 8 });
  db = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });

  const sync = (id: string, incoming = INCOMING_RAW, strategy = new PassthroughStrategy(), opts: any = POLICY) =>
    kyselySyncJsonb(db, 'kysely_docs', 'id', id, 'doc', incoming, strategy, opts);

  test('merges and PERSISTS through the plugin (full canonical policy)', async () => {
    await resetTable(TABLE);
    await seed(TABLE, 'k1', BASE_DOC);

    const returned = await sync('k1');
    ok(typeof returned === 'string', 'plugin returned the merged raw JSON string');
    deepEqual(JSON.parse(returned), EXPECTED_MERGED, 'returned value matches expectation');

    // independent raw connection — an in-memory-only merge fails here
    const persisted = await readPersisted(TABLE, 'id', 'k1', 'doc');
    deepEqual(persisted, EXPECTED_MERGED, 'merged document PERSISTED to the jsonb column');
  });

  test('deep merge of nested objects (persisted)', async () => {
    await resetTable(TABLE);
    await seed(TABLE, 'deep', BASE_DOC);
    await sync('deep');
    const p = await readPersisted(TABLE, 'id', 'deep', 'doc');
    equal(p.profile.name, 'Ada', 'sibling key preserved at depth 1');
    equal(p.profile.theme.mode, 'dark', 'sibling key preserved at depth 2');
    equal(p.profile.theme.accent, 'red', 'conflicting key taken from incoming at depth 2');
    equal(p.profile.locale, 'en-GB', 'new key added at depth 1');
    deepEqual(p.profile.contact, { email: 'ada@example.com' }, 'untouched subtree preserved wholesale');
  });

  test('keyed-array reconciliation: stale rejected, fresh applied, new appended (persisted)', async () => {
    await resetTable(TABLE);
    await seed(TABLE, 'arr', BASE_DOC);
    await sync('arr');
    const p = await readPersisted(TABLE, 'id', 'arr', 'doc');
    const byId = Object.fromEntries(p.items.map((i: any) => [i.id, i]));

    equal(p.items.length, 3, 'exactly 3 elements');
    equal(byId.a.qty, 1, 'STALE id=a rejected: qty unchanged');
    equal(byId.a.note, 'base-a', 'STALE id=a rejected: note unchanged');
    equal(byId.a.updatedAt, '2026-06-01T00:00:00Z', 'STALE id=a kept its newer updatedAt');
    equal(byId.b.qty, 42, 'FRESH sibling id=b applied in the SAME array');
    equal(byId.b.note, 'fresh-b', 'FRESH sibling id=b note applied');
    equal(byId.c.qty, 7, 'NEW id=c appended');
    equal(p.items[2].id, 'c', 'NEW element appended at the end');
  });

  test('createdAt FWW rejects a re-creation (persisted)', async () => {
    await resetTable(TABLE);
    await seed(TABLE, 'fww', BASE_DOC);
    await sync('fww');
    const p = await readPersisted(TABLE, 'id', 'fww', 'doc');
    equal(p.audit.createdAt, '2026-01-01T00:00:00Z', 'original createdAt retained');
    equal(p.audit.actor, 'original-owner', 'impostor actor rejected with the subtree');
  });

  test('repeated apply is semantically idempotent (parsed compare)', async () => {
    await resetTable(TABLE);
    await seed(TABLE, 'idem', BASE_DOC);

    await sync('idem');
    const a1 = await readPersisted(TABLE, 'id', 'idem', 'doc');
    await sync('idem');
    const a2 = await readPersisted(TABLE, 'id', 'idem', 'doc');
    await sync('idem');
    const a3 = await readPersisted(TABLE, 'id', 'idem', 'doc');

    deepEqual(a2, a1, 'apply #2 was a no-op');
    deepEqual(a3, a1, 'apply #3 was a no-op');
    equal(a3.items.length, 3, 'keyed array did not grow');
    equal(a3.tags.length, 3, 'union-style array did not grow');
    equal(stable(a1), stable(EXPECTED_MERGED), 'converged on the expected document');

    // Raw text is NOT expected to be stable across writes (jsonb key ordering),
    // so prove the parsed values match while acknowledging that.
    const raw = await exec(`select doc::text as t from ${TABLE} where id = 'idem'`);
    ok(typeof raw.rows[0].t === 'string', 'raw jsonb text is readable');
  });

  test('custom strategy override reaches the C core (persisted)', async () => {
    await resetTable(TABLE);
    await seed(TABLE, 'ov', BASE_DOC);
    const strategy = new OverrideStrategy();
    await kyselySyncJsonb(db, 'kysely_docs', 'id', 'ov', 'doc', INCOMING_RAW, strategy, POLICY);

    ok(strategy.calls.includes('accent'), 'override invoked for nested scalar "accent"');
    ok(strategy.calls.includes('qty'), 'override invoked for a key inside a keyed-array element');

    const p = await readPersisted(TABLE, 'id', 'ov', 'doc');
    equal(p.profile.theme.accent, 'override(blue->red)', 'override result persisted');
    equal(p.items.find((i: any) => i.id === 'b').qty, 44, 'override summed qty (2+42) inside the array');
    deepEqual(p, EXPECTED_MERGED_WITH_OVERRIDE, 'full overridden document persisted');
  });

  test('merge options are forwarded: omitting the policy changes the outcome', async () => {
    await resetTable(TABLE);
    await seed(TABLE, 'noopt', BASE_DOC);
    // No options at all -> core defaults: REPLACE arrays, no timestamp resolution
    await kyselySyncJsonb(db, 'kysely_docs', 'id', 'noopt', 'doc', INCOMING_RAW, new PassthroughStrategy());
    const p = await readPersisted(TABLE, 'id', 'noopt', 'doc');
    equal(p.items.find((i: any) => i.id === 'a').qty, 999, 'without the policy the STALE element WINS');
    equal(p.audit.createdAt, '2030-01-01T00:00:00Z', 'without the policy FWW does not protect createdAt');

    await resetTable(TABLE);
    await seed(TABLE, 'opt', BASE_DOC);
    await sync('opt');
    const q = await readPersisted(TABLE, 'id', 'opt', 'doc');
    equal(q.items.find((i: any) => i.id === 'a').qty, 1, 'with the policy the STALE element is rejected');
    equal(q.audit.createdAt, '2026-01-01T00:00:00Z', 'with the policy FWW protects createdAt');
  });

  test('arrayMatchKeys is forwarded (identity key other than "id")', async () => {
    await resetTable(TABLE);
    await seed(TABLE, 'mk', { rows: [{ sku: 'x', v: 1 }, { sku: 'y', v: 1 }] });
    await kyselySyncJsonb(
      db, 'kysely_docs', 'id', 'mk', 'doc',
      JSON.stringify({ rows: [{ sku: 'x', v: 2 }, { sku: 'z', v: 9 }] }),
      new PassthroughStrategy(),
      { arrayStrategy: 4, arrayMatchKeys: 'sku' },
    );
    const p = await readPersisted(TABLE, 'id', 'mk', 'doc');
    equal(p.rows.length, 3, 'matched on sku: x merged, y kept, z appended');
    equal(p.rows.find((r: any) => r.sku === 'x').v, 2, 'sku=x merged rather than duplicated');
  });

  /* ---- defect regression tests ---- */

  test('DEFECT: a missing row throws instead of silently pretending to persist', async () => {
    await resetTable(TABleOrSelf());
    await rejects(
      () => sync('does-not-exist'),
      /no row in "kysely_docs"/,
      'missing row raises SyncerRowNotFoundError',
    );
    let err: any;
    try {
      await sync('does-not-exist');
    } catch (e) {
      err = e;
    }
    ok(err instanceof SyncerRowNotFoundError, 'error is a typed SyncerRowNotFoundError');
    // and it must NOT have created anything
    const r = await exec(`select count(*)::int as n from ${TABLE}`);
    equal(r.rows[0].n, 0, 'no row was inserted as a side effect');
  });

  test('DEFECT: a SQL NULL jsonb column is treated as an empty document', async () => {
    await resetTable(TABLE);
    await exec(`alter table ${TABLE} alter column doc drop not null`);
    await exec(`insert into ${TABLE} (id, doc) values ('nul', null)`);
    const merged = await sync('nul');
    deepEqual(
      JSON.parse(merged),
      JSON.parse(INCOMING_RAW),
      'NULL base merged as {} so the incoming document is adopted whole',
    );
    deepEqual(
      await readPersisted(TABLE, 'id', 'nul', 'doc'),
      JSON.parse(INCOMING_RAW),
      'result persisted over the NULL',
    );
  });

  test('DEFECT: concurrent syncs of one row do not lose a merge (FOR UPDATE lock)', async () => {
    await resetTable(TABLE);
    // Start from an empty doc and have N writers each add a distinct keyed
    // element. Without the row lock these read-modify-write cycles interleave
    // and only the last writer's element survives.
    await seed(TABLE, 'race', { items: [] });

    const N = 8;
    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        kyselySyncJsonb(
          db, 'kysely_docs', 'id', 'race', 'doc',
          JSON.stringify({ items: [{ id: `w${i}`, v: i }] }),
          new PassthroughStrategy(),
          POLICY,
        ),
      ),
    );

    const p = await readPersisted(TABLE, 'id', 'race', 'doc');
    equal(p.items.length, N, `all ${N} concurrent merges survived (no lost update)`);
    const ids = new Set(p.items.map((i: any) => i.id));
    ok(
      Array.from({ length: N }, (_, i) => `w${i}`).every((k) => ids.has(k)),
      'every writer element is present',
    );
  });

  test('runs inside a caller-provided transaction and is rolled back with it', async () => {
    await resetTable(TABLE);
    await seed(TABLE, 'tx', BASE_DOC);

    await db
      .transaction()
      .execute(async (trx) => {
        ok(trx.isTransaction, 'kysely reports the handle as a transaction');
        await kyselySyncJsonb(trx, 'kysely_docs', 'id', 'tx', 'doc', INCOMING_RAW, new PassthroughStrategy(), POLICY);
        // visible inside the transaction
        const inside = await trx
          .selectFrom('kysely_docs')
          .select(sql<string>`doc::text`.as('t'))
          .where('id', '=', 'tx')
          .executeTakeFirstOrThrow();
        deepEqual(JSON.parse(inside.t), EXPECTED_MERGED, 'merge visible inside the caller transaction');
        throw new Error('deliberate rollback');
      })
      .catch((e) => {
        if (!/deliberate rollback/.test(e.message)) throw e;
      });

    deepEqual(
      await readPersisted(TABLE, 'id', 'tx', 'doc'),
      BASE_DOC,
      'plugin joined the caller transaction, so the rollback undid the merge',
    );
  });

  test('column identifier is quoted, not interpolated (injection attempt is inert)', async () => {
    await resetTable(TABLE);
    await seed(TABLE, 'inj', BASE_DOC);
    // A hostile "column name" must be treated as an identifier and fail to
    // resolve, never execute. `sql.ref` quotes it.
    await rejects(
      () =>
        kyselySyncJsonb(
          db, 'kysely_docs', 'id', 'inj',
          'doc"; drop table kysely_docs; --' as any,
          INCOMING_RAW, new PassthroughStrategy(), POLICY,
        ),
      /.+/,
      'hostile column name is rejected by Postgres as an unknown identifier',
    );
    const still = await exec(
      `select count(*)::int as n from information_schema.tables where table_name = $1`,
      [TABLE],
    );
    equal(still.rows[0].n, 1, 'table still exists — no SQL injection');
  });

  test('JSON content containing quotes and SQL metacharacters survives intact', async () => {
    await resetTable(TABLE);
    await seed(TABLE, 'q', { note: 'base' });
    const nasty = `he said "hi"; drop table kysely_docs; -- '\\ 100%`;
    await kyselySyncJsonb(
      db, 'kysely_docs', 'id', 'q', 'doc',
      JSON.stringify({ note: nasty, nested: { s: "O'Brien" } }),
      new PassthroughStrategy(), POLICY,
    );
    const p = await readPersisted(TABLE, 'id', 'q', 'doc');
    equal(p.note, nasty, 'quotes/semicolons in JSON content round-trip verbatim (bound parameter)');
    equal(p.nested.s, "O'Brien", "single quote in nested JSON content survives");
    const still = await exec(
      `select count(*)::int as n from information_schema.tables where table_name = $1`,
      [TABLE],
    );
    equal(still.rows[0].n, 1, 'table still exists — payload was never SQL');
  });

  test('invalid incoming JSON throws rather than writing garbage', async () => {
    await resetTable(TABLE);
    await seed(TABLE, 'bad', BASE_DOC);
    await rejects(
      () => sync('bad', '{ not json'),
      /was not valid JSON/,
      'null from the core becomes a descriptive throw',
    );
    deepEqual(await readPersisted(TABLE, 'id', 'bad', 'doc'), BASE_DOC, 'row untouched after a failed merge');
  });
}

function tabLeOrSelf() {
  return TABLE;
}
// alias kept tiny to avoid a typo above being silently wrong
function TABleOrSelf() {
  return tabLeOrSelf();
}

export async function teardown() {
  await db?.destroy();
}
