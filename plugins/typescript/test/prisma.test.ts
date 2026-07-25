/**
 * REAL integration test for the Prisma plugin.
 *
 * Uses a genuinely generated Prisma Client (see test/prisma-schema/schema.prisma)
 * against a real Postgres table with a real `jsonb` column.
 *
 * The client is generated into node_modules/.prisma/opto-sync-test-client by
 * `npm run prisma:generate`. If that has not been run, this suite reports a
 * skip rather than a pass — it never fakes coverage.
 */
import { createRequire } from 'node:module';
import * as path from 'node:path';

import { withSyncer } from '../prisma';
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
  exec,
} from './harness';

const TABLE = 'prisma_docs';
const CLIENT_DIR = path.resolve(__dirname, '../node_modules/.prisma/opto-sync-test-client');

let prisma: any;
let xprisma: any;

/** Reports whether the generated client is available. */
export function available(): boolean {
  try {
    createRequire(__filename)(CLIENT_DIR);
    return true;
  } catch {
    return false;
  }
}

async function resetPrismaTable() {
  await exec(`drop table if exists ${TABLE}`);
  await exec(`create table ${TABLE} (id text primary key, doc jsonb not null, label text)`);
}

async function seedPrisma(id: string, doc: unknown) {
  await exec(`insert into ${TABLE} (id, doc) values ($1, $2::jsonb)`, [id, JSON.stringify(doc)]);
}

export async function register() {
  suite('prisma (REAL generated client, real Postgres jsonb)');

  if (!available()) {
    test('SKIPPED: generated Prisma client not found', async () => {
      ok(false, `run "npm run prisma:generate" first — no client at ${CLIENT_DIR}`);
    });
    return;
  }

  const { PrismaClient } = createRequire(__filename)(CLIENT_DIR);
  prisma = new PrismaClient();

  // NB: opts is passed positionally with no default — a default here would turn
  // an intentional `undefined` (meaning "no merge options at all") back into
  // POLICY and silently defeat the options-forwarding test.
  const extend = (strategy: any, opts: any, model = 'PrismaDoc') =>
    prisma.$extends(withSyncer(model, 'doc', strategy, opts));

  xprisma = extend(new PassthroughStrategy(), POLICY);

  const sync = (id: string, incoming = INCOMING_RAW, client = xprisma) =>
    client.prismaDoc.syncJsonField({ id }, incoming);

  test('merges and PERSISTS through the extension (full canonical policy)', async () => {
    await resetPrismaTable();
    await seedPrisma('p1', BASE_DOC);

    const returned = await sync('p1');
    ok(returned && typeof returned === 'object', 'extension returns the updated record');
    deepEqual(returned.doc, EXPECTED_MERGED, 'returned record carries the merged document');

    // independent raw connection
    deepEqual(
      await readPersisted(TABLE, 'id', 'p1', 'doc'),
      EXPECTED_MERGED,
      'merged document PERSISTED to the jsonb column',
    );
  });

  test('deep merge of nested objects (persisted)', async () => {
    await resetPrismaTable();
    await seedPrisma('deep', BASE_DOC);
    await sync('deep');
    const p = await readPersisted(TABLE, 'id', 'deep', 'doc');
    equal(p.profile.name, 'Ada', 'sibling key preserved at depth 1');
    equal(p.profile.theme.mode, 'dark', 'sibling key preserved at depth 2');
    equal(p.profile.theme.accent, 'red', 'conflicting key taken from incoming');
    equal(p.profile.locale, 'en-GB', 'new nested key added');
    deepEqual(p.profile.contact, { email: 'ada@example.com' }, 'untouched subtree preserved');
  });

  test('keyed-array reconciliation: stale rejected, fresh applied, new appended (persisted)', async () => {
    await resetPrismaTable();
    await seedPrisma('arr', BASE_DOC);
    await sync('arr');
    const p = await readPersisted(TABLE, 'id', 'arr', 'doc');
    const by = Object.fromEntries(p.items.map((i: any) => [i.id, i]));
    equal(p.items.length, 3, 'exactly 3 elements');
    equal(by.a.qty, 1, 'STALE id=a rejected');
    equal(by.a.note, 'base-a', 'STALE id=a rejected (note)');
    equal(by.b.qty, 42, 'FRESH sibling id=b applied');
    equal(by.c.qty, 7, 'NEW id=c appended');
    equal(p.items[2].id, 'c', 'appended at the end');
  });

  test('createdAt FWW rejects a re-creation (persisted)', async () => {
    await resetPrismaTable();
    await seedPrisma('fww', BASE_DOC);
    await sync('fww');
    const p = await readPersisted(TABLE, 'id', 'fww', 'doc');
    equal(p.audit.createdAt, '2026-01-01T00:00:00Z', 'original createdAt retained');
    equal(p.audit.actor, 'original-owner', 'impostor rejected with the subtree');
  });

  test('repeated apply is semantically idempotent (parsed compare)', async () => {
    await resetPrismaTable();
    await seedPrisma('idem', BASE_DOC);
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
    await resetPrismaTable();
    await seedPrisma('ov', BASE_DOC);
    const strategy = new OverrideStrategy();
    await sync('ov', INCOMING_RAW, extend(strategy, POLICY));
    ok(strategy.calls.includes('accent'), 'override invoked for nested scalar');
    ok(strategy.calls.includes('qty'), 'override invoked inside a keyed-array element');
    const p = await readPersisted(TABLE, 'id', 'ov', 'doc');
    equal(p.profile.theme.accent, 'override(blue->red)', 'override result persisted');
    equal(p.items.find((i: any) => i.id === 'b').qty, 44, 'override summed qty (2+42)');
    deepEqual(p, EXPECTED_MERGED_WITH_OVERRIDE, 'full overridden document persisted');
  });

  test('merge options are forwarded: omitting the policy changes the outcome', async () => {
    await resetPrismaTable();
    await seedPrisma('noopt', BASE_DOC);
    await sync('noopt', INCOMING_RAW, extend(new PassthroughStrategy(), undefined));  // no options at all
    const p = await readPersisted(TABLE, 'id', 'noopt', 'doc');
    equal(p.items.find((i: any) => i.id === 'a').qty, 999, 'without the policy the STALE element WINS');
    equal(p.audit.createdAt, '2030-01-01T00:00:00Z', 'without the policy FWW does not protect createdAt');
  });

  /* ---- defect regression tests ---- */

  test('PRIOR FINDING CONFIRMED FIXED: a missing record throws a descriptive error', async () => {
    await resetPrismaTable();
    await rejects(
      () => sync('does-not-exist'),
      /no PrismaDoc record matches/,
      'missing record produces a descriptive throw, not a Prisma internal error',
    );
    // and nothing was created
    const r = await exec(`select count(*)::int as n from ${TABLE}`);
    equal(r.rows[0].n, 0, 'no row inserted as a side effect');
  });

  test('DEFECT: a JSON null field is treated as an empty document', async () => {
    await resetPrismaTable();
    // Prisma "Json" maps a SQL NULL to null on read.
    await exec(`alter table ${TABLE} alter column doc drop not null`);
    await exec(`insert into ${TABLE} (id, doc) values ('nul', null)`);
    const rec = await sync('nul');
    deepEqual(rec.doc, JSON.parse(INCOMING_RAW), 'NULL base merged as {} so incoming is adopted');
    deepEqual(
      await readPersisted(TABLE, 'id', 'nul', 'doc'),
      JSON.parse(INCOMING_RAW),
      'result persisted over the NULL',
    );
  });

  test('DEFECT: a wrong fieldName fails with a clear message, not "String expected"', async () => {
    await resetPrismaTable();
    await seedPrisma('wf', BASE_DOC);
    const bad = prisma.$extends(withSyncer('PrismaDoc', 'noSuchField', new PassthroughStrategy(), POLICY));
    await rejects(
      () => bad.prismaDoc.syncJsonField({ id: 'wf' }, INCOMING_RAW),
      /has no field "noSuchField"/,
      'missing field is diagnosed instead of crashing inside the native addon',
    );
    deepEqual(await readPersisted(TABLE, 'id', 'wf', 'doc'), BASE_DOC, 'row untouched');
  });

  test('DEFECT: calling the extension on a different model is refused', async () => {
    await resetPrismaTable();
    await seedPrisma('wm', BASE_DOC);
    // Configured for a model that is NOT prismaDoc; $allModels would otherwise
    // happily merge the wrong field.
    const misconfigured = prisma.$extends(
      withSyncer('SomeOtherModel', 'doc', new PassthroughStrategy(), POLICY),
    );
    await rejects(
      () => misconfigured.prismaDoc.syncJsonField({ id: 'wm' }, INCOMING_RAW),
      /configured for model "SomeOtherModel" .* called on "PrismaDoc"/s,
      'model mismatch is refused rather than silently merging',
    );
    deepEqual(await readPersisted(TABLE, 'id', 'wm', 'doc'), BASE_DOC, 'row untouched');
  });

  test('DEFECT: concurrent syncs of one row do not lose a merge (CAS + retry)', async () => {
    await resetPrismaTable();
    await seedPrisma('race', { items: [] });

    const N = 8;
    const results = await Promise.allSettled(
      Array.from({ length: N }, (_, i) =>
        xprisma.prismaDoc.syncJsonField(
          { id: 'race' },
          JSON.stringify({ items: [{ id: `w${i}`, v: i }] }),
        ),
      ),
    );
    const rejected = results.filter((r) => r.status === 'rejected');
    equal(rejected.length, 0, `no writer gave up (${rejected.map((r: any) => r.reason?.message).join('; ')})`);

    const p = await readPersisted(TABLE, 'id', 'race', 'doc');
    equal(p.items.length, N, `all ${N} concurrent merges survived (no lost update)`);
    const ids = new Set(p.items.map((i: any) => i.id));
    ok(
      Array.from({ length: N }, (_, i) => `w${i}`).every((k) => ids.has(k)),
      'every writer element is present',
    );
  });

  test('JSON content containing quotes and SQL metacharacters survives intact', async () => {
    await resetPrismaTable();
    await seedPrisma('q', { note: 'base' });
    const nasty = `he said "hi"; drop table prisma_docs; -- '\\ 100%`;
    await sync('q', JSON.stringify({ note: nasty, nested: { s: "O'Brien" } }));
    const p = await readPersisted(TABLE, 'id', 'q', 'doc');
    equal(p.note, nasty, 'quotes/semicolons round-trip verbatim');
    equal(p.nested.s, "O'Brien", 'single quote in nested content survives');
    const still = await exec(
      `select count(*)::int as n from information_schema.tables where table_name = $1`,
      [TABLE],
    );
    equal(still.rows[0].n, 1, 'table still exists');
  });

  test('invalid incoming JSON throws rather than writing garbage', async () => {
    await resetPrismaTable();
    await seedPrisma('bad', BASE_DOC);
    await rejects(() => sync('bad', '{ not json'), /was not valid JSON/, 'descriptive throw');
    deepEqual(await readPersisted(TABLE, 'id', 'bad', 'doc'), BASE_DOC, 'row untouched');
  });
}

export async function teardown() {
  await prisma?.$disconnect?.();
  await exec(`drop table if exists ${TABLE}`).catch(() => {});
}
