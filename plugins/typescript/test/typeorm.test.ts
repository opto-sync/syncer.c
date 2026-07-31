/**
 * REAL integration test for the TypeORM plugin.
 *
 * Uses the actual `typeorm` package with its postgres driver against a real
 * Postgres table with a real `jsonb` column.
 *
 * Decorators are deliberately avoided: `EntitySchema` gives the same runtime
 * metadata without needing `experimentalDecorators`/`emitDecoratorMetadata`, so
 * the suite runs under the repo's plain tsconfig. `reflect-metadata` is still
 * imported because TypeORM requires it at load time.
 */
import 'reflect-metadata';
import { DataSource, EntitySchema } from 'typeorm';

import { typeOrmSyncMerge, SyncerJsonbTransformer, SyncerRowNotFoundError } from '../typeorm';
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
  exec,
  CONN,
} from './harness';

const TABLE = 'typeorm_docs';

const DocEntity = new EntitySchema<any>({
  name: 'TypeormDoc',
  tableName: TABLE,
  columns: {
    id: { type: 'text', primary: true },
    doc: { type: 'jsonb', nullable: true },
    label: { type: 'text', nullable: true },
  },
});

/** Same shape, keyed on a column that is NOT called "id". */
const AltKeyEntity = new EntitySchema<any>({
  name: 'TypeormAltDoc',
  tableName: 'typeorm_altkey',
  columns: {
    docKey: { type: 'text', primary: true, name: 'doc_key' },
    doc: { type: 'jsonb', nullable: true },
  },
});

let ds: DataSource;

export async function register() {
  suite('typeorm (REAL package, real Postgres jsonb)');

  await resetTable(TABLE);
  ds = new DataSource({
    type: 'postgres',
    url: CONN,
    entities: [DocEntity, AltKeyEntity],
    synchronize: false,
    logging: false,
  });
  await ds.initialize();

  const repo = () => ds.getRepository(DocEntity);
  const sync = (
    id: string,
    incoming = INCOMING_RAW,
    strategy = new PassthroughStrategy(),
    opts: any = POLICY,
  ) => typeOrmSyncMerge(repo(), id, 'doc', incoming, strategy, opts);

  test('SyncerJsonbTransformer is an identity ValueTransformer', async () => {
    const t = SyncerJsonbTransformer(new PassthroughStrategy());
    deepEqual(t.to(BASE_DOC as any), BASE_DOC, 'to() passes the value through');
    deepEqual(t.from(BASE_DOC), BASE_DOC, 'from() passes the value through');
    ok(typeof t.to === 'function' && typeof t.from === 'function', 'shape matches TypeORM ValueTransformer');
  });

  test('merges and PERSISTS through the plugin (full canonical policy)', async () => {
    await resetTable(TABLE);
    await seed(TABLE, 't1', BASE_DOC);
    const returned = await sync('t1');
    ok(typeof returned === 'string', 'plugin returns the merged raw JSON string');
    deepEqual(JSON.parse(returned), EXPECTED_MERGED, 'returned value matches expectation');
    deepEqual(
      await readPersisted(TABLE, 'id', 't1', 'doc'),
      EXPECTED_MERGED,
      'merged document PERSISTED to the jsonb column',
    );
  });

  test('deep merge of nested objects (persisted)', async () => {
    await resetTable(TABLE);
    await seed(TABLE, 'deep', BASE_DOC);
    await sync('deep');
    const p = await readPersisted(TABLE, 'id', 'deep', 'doc');
    equal(p.profile.name, 'Ada', 'sibling key preserved at depth 1');
    equal(p.profile.theme.mode, 'dark', 'sibling key preserved at depth 2');
    equal(p.profile.theme.accent, 'red', 'conflicting key taken from incoming');
    equal(p.profile.locale, 'en-GB', 'new nested key added');
  });

  test('keyed-array reconciliation: stale rejected, fresh applied, new appended (persisted)', async () => {
    await resetTable(TABLE);
    await seed(TABLE, 'arr', BASE_DOC);
    await sync('arr');
    const p = await readPersisted(TABLE, 'id', 'arr', 'doc');
    const byId = Object.fromEntries(p.items.map((i: any) => [i.id, i]));
    equal(p.items.length, 3, 'exactly 3 elements');
    equal(byId.a.qty, 1, 'STALE id=a rejected');
    equal(byId.b.qty, 42, 'FRESH sibling id=b applied');
    equal(byId.c.qty, 7, 'NEW id=c appended');
    equal(p.items[2].id, 'c', 'appended at the end');
  });

  test('createdAt FWW rejects a re-creation when opted into explicitly (persisted)', async () => {
    await resetTable(TABLE);
    await seed(TABLE, 'fww', BASE_DOC);
    await sync('fww', INCOMING_RAW, new PassthroughStrategy(), FWW_POLICY);
    const p = await readPersisted(TABLE, 'id', 'fww', 'doc');
    deepEqual(p, EXPECTED_MERGED_FWW, 'explicit FWW vetoes the audit subtree wholesale');
    equal(p.audit.createdAt, '2026-01-01T00:00:00Z', 'original createdAt retained');
    equal(p.audit.actor, 'original-owner', 'impostor rejected with the subtree');
  });

  test('the DEFAULT policy does NOT veto on createdAt (persisted)', async () => {
    // FWW is a node-level veto, so a default createdAt key would let any replica
    // holding a later createdAt permanently and silently stop accepting writes.
    await resetTable(TABLE);
    await seed(TABLE, 'nofww', BASE_DOC);
    await sync('nofww');
    const p = await readPersisted(TABLE, 'id', 'nofww', 'doc');
    equal(p.audit.createdAt, '2030-01-01T00:00:00Z', 'no default FWW: audit deep-merges');
    equal(p.audit.actor, 'impostor', 'no default FWW: the incoming actor lands');
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
    equal(stable(a1), stable(EXPECTED_MERGED), 'converged on the expected document');
  });

  test('custom strategy override reaches the C core (persisted)', async () => {
    await resetTable(TABLE);
    await seed(TABLE, 'ov', BASE_DOC);
    const strategy = new OverrideStrategy();
    await typeOrmSyncMerge(repo(), 'ov', 'doc', INCOMING_RAW, strategy, POLICY);
    ok(strategy.calls.includes('accent'), 'override invoked for nested scalar');
    ok(strategy.calls.includes('qty'), 'override invoked inside a keyed-array element');
    const p = await readPersisted(TABLE, 'id', 'ov', 'doc');
    equal(p.profile.theme.accent, 'override(blue->red)', 'override result persisted');
    equal(p.items.find((i: any) => i.id === 'b').qty, 44, 'override summed qty (2+42)');
    deepEqual(p, EXPECTED_MERGED_WITH_OVERRIDE, 'full overridden document persisted');
  });

  test('merge options are forwarded: omitting the policy changes the outcome', async () => {
    await resetTable(TABLE);
    await seed(TABLE, 'noopt', BASE_DOC);
    await typeOrmSyncMerge(repo(), 'noopt', 'doc', INCOMING_RAW, new PassthroughStrategy());
    const p = await readPersisted(TABLE, 'id', 'noopt', 'doc');
    equal(p.items.find((i: any) => i.id === 'a').qty, 999, 'without the policy the STALE element WINS');

    // fwwKeys is forwarded too, but only when explicitly asked for.
    await resetTable(TABLE);
    await seed(TABLE, 'optfww', BASE_DOC);
    await sync('optfww', INCOMING_RAW, new PassthroughStrategy(), FWW_POLICY);
    const q = await readPersisted(TABLE, 'id', 'optfww', 'doc');
    equal(q.audit.createdAt, '2026-01-01T00:00:00Z', 'explicit fwwKeys is forwarded and protects the node');
  });

  /* ---- defect regression tests ---- */

  test('DEFECT: a missing row throws instead of silently pretending to persist', async () => {
    await resetTable(TABLE);
    await rejects(() => sync('nope'), /no row where "id"/, 'missing row raises SyncerRowNotFoundError');
    let err: any;
    try {
      await sync('nope');
    } catch (e) {
      err = e;
    }
    ok(err instanceof SyncerRowNotFoundError, 'error is a typed SyncerRowNotFoundError');
    const r = await exec(`select count(*)::int as n from ${TABLE}`);
    equal(r.rows[0].n, 0, 'no row inserted as a side effect');
  });

  test('DEFECT: a SQL NULL jsonb column is treated as an empty document', async () => {
    await resetTable(TABLE);
    await exec(`alter table ${TABLE} alter column doc drop not null`);
    await exec(`insert into ${TABLE} (id, doc) values ('nul', null)`);
    const merged = await sync('nul');
    deepEqual(JSON.parse(merged), JSON.parse(INCOMING_RAW), 'NULL base merged as {}');
    deepEqual(
      await readPersisted(TABLE, 'id', 'nul', 'doc'),
      JSON.parse(INCOMING_RAW),
      'result persisted over the NULL',
    );
  });

  test('DEFECT: concurrent syncs of one row do not lose a merge (pessimistic_write)', async () => {
    await resetTable(TABLE);
    await seed(TABLE, 'race', { items: [] });
    const N = 8;
    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        typeOrmSyncMerge(
          repo(),
          'race',
          'doc',
          JSON.stringify({ items: [{ id: `w${i}`, v: i }] }),
          new PassthroughStrategy(),
          POLICY,
        ),
      ),
    );
    const p = await readPersisted(TABLE, 'id', 'race', 'doc');
    equal(p.items.length, N, `all ${N} concurrent merges survived (no lost update)`);
  });

  test('DEFECT: a non-"id" primary key is supported via the idColumn argument', async () => {
    await exec(`drop table if exists typeorm_altkey`);
    await exec(`create table typeorm_altkey (doc_key text primary key, doc jsonb)`);
    await exec(`insert into typeorm_altkey (doc_key, doc) values ($1, $2::jsonb)`, [
      'k1',
      JSON.stringify(BASE_DOC),
    ]);

    const altRepo = ds.getRepository(AltKeyEntity);
    // Default idColumn ("id") cannot work here — the entity has no such property.
    await rejects(
      () => typeOrmSyncMerge(altRepo, 'k1', 'doc', INCOMING_RAW, new PassthroughStrategy(), POLICY),
      /.+/,
      'default "id" key fails loudly on an entity keyed differently',
    );
    // Explicit idColumn works.
    await typeOrmSyncMerge(altRepo, 'k1', 'doc', INCOMING_RAW, new PassthroughStrategy(), POLICY, 'docKey');
    deepEqual(
      await readPersisted('typeorm_altkey', 'doc_key', 'k1', 'doc'),
      EXPECTED_MERGED,
      'merged and persisted against a non-"id" primary key',
    );
    await exec(`drop table if exists typeorm_altkey`);
  });

  test('unsafe identifiers are rejected before reaching SQL', async () => {
    await resetTable(TABLE);
    await seed(TABLE, 'inj', BASE_DOC);
    await rejects(
      () => typeOrmSyncMerge(repo(), 'inj', 'doc"; drop table typeorm_docs; --', INCOMING_RAW, new PassthroughStrategy(), POLICY),
      /unsafe column name/,
      'hostile column name rejected by SAFE_IDENTIFIER',
    );
    await rejects(
      () => typeOrmSyncMerge(repo(), 'inj', 'doc', INCOMING_RAW, new PassthroughStrategy(), POLICY, 'id; drop table typeorm_docs; --'),
      /unsafe id column name/,
      'hostile id column name rejected by SAFE_IDENTIFIER',
    );
    const still = await exec(
      `select count(*)::int as n from information_schema.tables where table_name = $1`,
      [TABLE],
    );
    equal(still.rows[0].n, 1, 'table still exists — no SQL injection');
    deepEqual(await readPersisted(TABLE, 'id', 'inj', 'doc'), BASE_DOC, 'row untouched');
  });

  test('JSON content containing quotes and SQL metacharacters survives intact', async () => {
    await resetTable(TABLE);
    await seed(TABLE, 'q', { note: 'base' });
    const nasty = `he said "hi"; drop table typeorm_docs; -- '\\ 100%`;
    await typeOrmSyncMerge(
      repo(), 'q', 'doc',
      JSON.stringify({ note: nasty, nested: { s: "O'Brien" } }),
      new PassthroughStrategy(), POLICY,
    );
    const p = await readPersisted(TABLE, 'id', 'q', 'doc');
    equal(p.note, nasty, 'quotes/semicolons round-trip verbatim (bound parameter)');
    equal(p.nested.s, "O'Brien", 'single quote in nested content survives');
    const still = await exec(
      `select count(*)::int as n from information_schema.tables where table_name = $1`,
      [TABLE],
    );
    equal(still.rows[0].n, 1, 'table still exists — payload was never SQL');
  });

  test('invalid incoming JSON throws rather than writing garbage', async () => {
    await resetTable(TABLE);
    await seed(TABLE, 'bad', BASE_DOC);
    await rejects(() => sync('bad', '{ not json'), /was not valid JSON/, 'descriptive throw');
    deepEqual(await readPersisted(TABLE, 'id', 'bad', 'doc'), BASE_DOC, 'row untouched');
  });
}

export async function teardown() {
  if (ds?.isInitialized) await ds.destroy();
  await exec(`drop table if exists typeorm_altkey`).catch(() => {});
}
