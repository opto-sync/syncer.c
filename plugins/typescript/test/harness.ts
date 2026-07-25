/**
 * Minimal test harness for the opto-sync ORM plugin integration tests.
 *
 * Deliberately dependency-free (no jest/vitest): the plugins ship as source
 * inside the syncer.c repo and the tests only need a real Postgres plus the
 * real ORM packages.
 */
import { Client, Pool } from 'pg';

export const CONN =
  process.env.OPTO_SYNC_TEST_PG ??
  'postgres://test:test@localhost:55432/plugintest';

let assertions = 0;
let failures = 0;
const failureLog: string[] = [];
let currentSuite = '';
let currentTest = '';

export function suite(name: string) {
  currentSuite = name;
  console.log(`\n\x1b[1m# ${name}\x1b[0m`);
}

const tests: Array<{ suite: string; name: string; fn: () => Promise<void> }> = [];

export function test(name: string, fn: () => Promise<void>) {
  tests.push({ suite: currentSuite, name, fn });
}

export async function runQueued(): Promise<void> {
  for (const t of tests) {
    currentTest = `${t.suite} :: ${t.name}`;
    const before = failures;
    try {
      await t.fn();
    } catch (e: any) {
      failures++;
      failureLog.push(`${currentTest}\n    THREW: ${e?.stack ?? e}`);
    }
    const ok = failures === before;
    console.log(`  ${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${t.name}`);
  }
  tests.length = 0;
}

function fail(msg: string) {
  failures++;
  failureLog.push(`${currentTest}\n    ${msg}`);
}

export function ok(cond: boolean, msg: string) {
  assertions++;
  if (!cond) fail(`assert ok FAILED: ${msg}`);
}

/** Deep structural equality on PARSED values — never compare raw jsonb text,
 *  Postgres reorders object keys and normalizes whitespace. */
export function deepEqual(actual: unknown, expected: unknown, msg: string) {
  assertions++;
  if (!structurallyEqual(actual, expected)) {
    fail(
      `assert deepEqual FAILED: ${msg}\n      actual:   ${stable(actual)}\n      expected: ${stable(expected)}`,
    );
  }
}

export function equal(actual: unknown, expected: unknown, msg: string) {
  assertions++;
  if (actual !== expected) {
    fail(`assert equal FAILED: ${msg}\n      actual:   ${stable(actual)}\n      expected: ${stable(expected)}`);
  }
}

export async function rejects(fn: () => Promise<unknown>, matcher: RegExp, msg: string) {
  assertions++;
  let threw: any;
  try {
    await fn();
  } catch (e) {
    threw = e;
  }
  if (threw === undefined) {
    fail(`assert rejects FAILED (did not throw): ${msg}`);
  } else if (!matcher.test(String(threw?.message ?? threw))) {
    fail(`assert rejects FAILED (wrong error): ${msg}\n      got: ${threw?.message ?? threw}`);
  }
}

function structurallyEqual(a: any, b: any): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (typeof a !== 'object') return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  if (Array.isArray(a)) {
    // arrays are order-sensitive (element order is part of the merge contract)
    for (let i = 0; i < a.length; i++) if (!structurallyEqual(a[i], b[i])) return false;
    return true;
  }
  for (const k of ka) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
    if (!structurallyEqual(a[k], b[k])) return false;
  }
  return true;
}

/** Key-sorted JSON, for readable diffs and for text comparison of parsed docs. */
export function stable(v: any): string {
  return JSON.stringify(sortKeys(v));
}

function sortKeys(v: any): any {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    const out: any = {};
    for (const k of Object.keys(v).sort()) out[k] = sortKeys(v[k]);
    return out;
  }
  return v;
}

export function report(): number {
  console.log(`\n${'-'.repeat(64)}`);
  if (failures > 0) {
    console.log(`\x1b[31mFAILURES (${failures}):\x1b[0m`);
    for (const f of failureLog) console.log(`  - ${f}`);
  }
  console.log(
    `${failures === 0 ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  assertions: ${assertions}, failures: ${failures}`,
  );
  return failures === 0 ? 0 : 1;
}

export function assertionCount() {
  return assertions;
}

/* -------------------------------------------------------------------------
 * Postgres helpers — an independent verification channel.
 *
 * Persistence is always re-read through this raw pool, NEVER through the ORM
 * under test, so an ORM-level cache or an in-memory-only merge cannot make a
 * test pass.
 * ------------------------------------------------------------------------- */

let verifyPool: Pool | null = null;

export function rawPool(): Pool {
  if (!verifyPool) verifyPool = new Pool({ connectionString: CONN, max: 4 });
  return verifyPool;
}

export async function closeRawPool() {
  if (verifyPool) {
    await verifyPool.end();
    verifyPool = null;
  }
}

/** Re-read a jsonb column as text through a raw connection and parse it. */
export async function readPersisted(
  table: string,
  idColumn: string,
  id: unknown,
  jsonColumn: string,
): Promise<any> {
  const r = await rawPool().query(
    `select ${quoteIdent(jsonColumn)}::text as raw from ${quoteIdent(table)} where ${quoteIdent(idColumn)} = $1`,
    [id],
  );
  if (r.rowCount === 0) return undefined;
  const raw = r.rows[0].raw;
  return raw === null ? null : JSON.parse(raw);
}

export function quoteIdent(s: string) {
  return `"${s.replace(/"/g, '""')}"`;
}

export async function exec(sqlText: string, params: unknown[] = []) {
  return rawPool().query(sqlText, params);
}

/** Create a fresh table with a real jsonb column. */
export async function resetTable(table: string) {
  await exec(`drop table if exists ${quoteIdent(table)}`);
  await exec(
    `create table ${quoteIdent(table)} (
       id text primary key,
       doc jsonb not null default '{}'::jsonb,
       label text
     )`,
  );
}

export async function seed(table: string, id: string, doc: unknown) {
  await exec(
    `insert into ${quoteIdent(table)} (id, doc) values ($1, $2::jsonb)
     on conflict (id) do update set doc = excluded.doc`,
    [id, JSON.stringify(doc)],
  );
}

export async function waitForPostgres(timeoutMs = 30_000) {
  const start = Date.now();
  let lastErr: any;
  while (Date.now() - start < timeoutMs) {
    const c = new Client({ connectionString: CONN });
    try {
      await c.connect();
      await c.query('select 1');
      await c.end();
      return;
    } catch (e) {
      lastErr = e;
      await c.end().catch(() => {});
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw new Error(`Postgres at ${CONN} not reachable: ${lastErr?.message}`);
}
