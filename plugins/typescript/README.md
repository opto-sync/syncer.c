# opto-sync ORM plugins (TypeScript)

Thin adapters that route an ORM's JSONB column writes through the `syncer.c`
core (v0.2.1) so a concurrent update **reconciles** with the stored document
instead of overwriting it.

All four adapters are covered by **real integration tests against a real
Postgres and the real ORM packages** — see [Running the tests](#running-the-tests).

| ORM          | Plugin entry point                                | Coverage                                    |
| ------------ | ------------------------------------------------- | ------------------------------------------- |
| `drizzle-orm`| `syncedJsonb()`, `performZeroDeserializationMerge()` | REAL integration (Postgres `jsonb` + `pg`) |
| `kysely`     | `kyselySyncJsonb()`                               | REAL integration (Postgres `jsonb` + `pg`)  |
| `typeorm`    | `typeOrmSyncMerge()`, `SyncerJsonbTransformer()`  | REAL integration (Postgres `jsonb`)         |
| `prisma`     | `withSyncer()` (client extension)                 | REAL integration (generated client)         |

The ORM packages are **peer dependencies** of your app. They are installed here
only as `devDependencies` so the tests and the real-package type-check can run.

---

## The canonical merge policy

Every opto-sync binding uses the same policy. Pass it as the merge-options
argument of whichever plugin you use:

```ts
import { ArrayStrategy } from '../../bindings/typescript';

export const POLICY = {
  arrayStrategy: ArrayStrategy.MERGE_BY_KEY, // 4
  arrayMatchKeys: 'id',
  resolveByTimestamp: true,
  lwwKeys: 'updatedAt,syncedAt',
};
```

What it buys you, all asserted through the database:

- **Deep merge.** Nested objects merge key-by-key; untouched subtrees survive.
- **Keyed-array reconciliation.** Array elements are matched by `id`. A *stale*
  element (older `updatedAt`) is rejected while a *fresh sibling in the same
  array* is applied and an unseen `id` is appended.
- **LWW.** `updatedAt`/`syncedAt` are last-write-wins. First-write-wins remains
  available explicitly, but is not a default because it vetoes the whole node,
  not only `createdAt`.
- **Idempotency.** Re-applying the same payload converges (arrays do not grow).

### Two sharp edges in the policy's semantics

These are core behaviours, not plugin bugs. They are pinned by
`test/core-contract.test.ts` so a core change surfaces there.

1. **Timestamp resolution is WHOLESALE per object, not per key.** If both sides
   of an object carry a `lwwKeys`/`fwwKeys` key, the *entire* object is accepted
   or rejected — the merge does not descend. So a **root-level** `updatedAt` or
   `createdAt` gates the whole document. Put timestamps at the level you
   actually want reconciled (e.g. on each array element), not only at the root.

2. **A custom strategy's override callback reaches arrays too** (core 0.2.1+).
   It is consulted for every node where both sides are present — scalars,
   objects, arrays, and a root-level array — before the configured strategy
   descends. Returning `null` declines and leaves the strategy's own behavior
   intact. Before 0.2.1 arrays skipped the callback under any non-`REPLACE`
   strategy, which silently disabled array overrides under the canonical policy.

   Consequence: array overrides in `UserProfileMerger` now fire before the
   configured array strategy. Return `undefined` to decline and let
   `MERGE_BY_KEY` continue.

Always bridge a strategy through `BaseMergeStrategy.toNativeCallback()` — the
plugins do this for you. Binding `handleConflict` directly never matches,
because the native callback receives a full JSON path, not a bare key.

---

## Usage

### drizzle-orm

`syncedJsonb()` is a `customType` producing a real `jsonb` column;
`performZeroDeserializationMerge()` merges two raw JSON strings in memory. It
does **not** touch the database — you read, merge, and write with Drizzle:

```ts
const rows = await db.select({ raw: sql<string>`${docs.doc}::text` })
  .from(docs).where(eq(docs.id, id));
const merged = performZeroDeserializationMerge(rows[0].raw, incomingRaw, strategy, POLICY);
await db.update(docs).set({ doc: merged }).where(eq(docs.id, id));
```

`toDriver` passes a raw JSON **string** through verbatim, so the merged output
goes straight back in without a stringify→parse→stringify round trip.

### kysely / typeorm

These do the whole read-merge-write for you, inside **one transaction with the
row locked** (`FOR UPDATE` / `pessimistic_write`), and return the persisted JSON
string. Both throw `SyncerRowNotFoundError` when the row does not exist.

```ts
await kyselySyncJsonb(db, 'docs', 'id', id, 'doc', incomingRaw, strategy, POLICY);
await typeOrmSyncMerge(repo, id, 'doc', incomingRaw, strategy, POLICY /*, idColumn */);
```

`kyselySyncJsonb` reuses a transaction you pass in (so it rolls back with
yours). `typeOrmSyncMerge` defaults to an `id` primary key; pass `idColumn` for
anything else.

### prisma

```ts
import { Prisma } from '@prisma/client';

const xprisma = prisma.$extends(
  withSyncer('Doc', 'doc', strategy, POLICY, { dbNull: Prisma.DbNull }),
);
await xprisma.doc.syncJsonField({ id }, incomingRaw);
```

Prisma's model API cannot express `SELECT ... FOR UPDATE`, so this uses
**optimistic concurrency**: the write is an `updateMany` whose `WHERE` also
requires the field to still equal the value the merge was computed from
(compare-and-set), retried with jittered backoff. Pass `dbNull` if the column is
nullable — Prisma cannot filter on "is SQL NULL" without that sentinel, and
without it the CAS is skipped for currently-NULL rows.

---

## Running the tests

Start a **throwaway** Postgres on a port nothing else uses:

```bash
docker run -d --name plugintest-pg -p 127.0.0.1:55987:5432 \
  -e POSTGRES_PASSWORD=test -e POSTGRES_USER=test -e POSTGRES_DB=plugintest \
  postgres:16-alpine
```

```bash
cd syncer.c/plugins/typescript
npm install
npm run prisma:generate     # once; needed for the prisma suite
npm test                    # type-checks, then runs every suite
```

Override the DSN with `OPTO_SYNC_TEST_PG` (default
`postgres://test:test@127.0.0.1:55987/plugintest`). Single suites:
`npm run test:drizzle | test:kysely | test:typeorm | test:prisma`.

`prisma generate` needs `OPTO_SYNC_TEST_PG` set (the schema's datasource reads
it), but the *test run* does not — the suite passes the DSN to `PrismaClient`
explicitly so Prisma always uses the same database as every other suite.

Pick a port nothing else holds. A stray `kubectl port-forward` on `localhost`
will shadow a Docker `0.0.0.0` publish and hand you the wrong database, which is
why the container is published on `127.0.0.1` at an unusual port.

Remove the container when done: `docker rm -f plugintest-pg`.

The native addon must be built first (`cd ../../bindings/typescript && npm install`).

### Type-checking

Two configurations, both run by `npm run typecheck`:

- `tsconfig.json` — checks against the ambient **stubs** in `types/`, so the
  plugins can be verified with no ORM packages installed.
- `tsconfig.real.json` — checks against the **real** packages and excludes
  `types/`. This matters: an ambient `declare module 'kysely'` *shadows* the real
  package, so a stub-only check proves nothing about the real API. This config
  is what caught the Kysely result-type defect listed below.

### How the tests avoid fooling themselves

- Persistence is re-read on an **independent raw `pg` connection**, never
  through the ORM under test, so an in-memory-only merge cannot pass.
- Documents are compared as **parsed values**. Postgres `jsonb` reorders object
  keys and normalizes whitespace, so raw-text comparison is meaningless.
- Every defect fix has a regression test that was **verified to fail against the
  unfixed code** — none of them are vacuous.

---

## Defects found and fixed

| Plugin  | Defect | Fix |
| ------- | ------ | --- |
| drizzle | `fromDriver` did `JSON.parse` on a value `pg` had **already parsed**, throwing `SyntaxError: "[object Object]" is not valid JSON` on *every* read of a synced column. | Parse only when the driver returns text. |
| drizzle | `toDriver` double-encoded an already-raw JSON string into a JSON string literal. | Pass strings through verbatim. |
| kysely  | A **missing row** fell back to `{}`, merged, then issued an `UPDATE` matching 0 rows — the caller got a merged string back and believed it was saved. | Throw `SyncerRowNotFoundError`; also check `numUpdatedRows`. |
| kysely  | A **SQL NULL** column crashed the native addon with `TypeError: String expected`. | Treat NULL as `{}`. |
| kysely  | **Lost updates.** Read-modify-write with no lock; 8 concurrent syncs left only **2** merges. | One transaction + `FOR UPDATE`; reuses a caller transaction. |
| kysely  | Runtime-generic table/column unions stopped type-checking on the patched 0.29 release, and the old signature rejected caller-owned `Transaction<DB>` handles. | Use typed raw builders with identifier nodes/bound values and accept either `Kysely<DB>` or `Transaction<DB>`. |
| typeorm | Missing row silently no-op'd, same as kysely. | Throw `SyncerRowNotFoundError`; also check `affected`. |
| typeorm | SQL NULL column crashed the addon. | Treat NULL as `{}`. |
| typeorm | **Lost updates**; 4 of 8 merges lost even inside a transaction. | Transaction + `setLock('pessimistic_write')`. |
| typeorm | Primary key hard-coded to `id`; entities keyed otherwise silently targeted a non-existent column. | Optional `idColumn` argument (default `'id'`), identifier-validated. |
| typeorm | Returned `Promise<void>`, so callers could not see what was persisted. | Returns the merged JSON string. |
| prisma  | A wrong/unselected `fieldName` made `JSON.stringify(undefined)` return a non-string, crashing the addon with an opaque `String expected`. | Explicit check naming the available fields. |
| prisma  | `$allModels` attached `syncJsonField` to **every** model while `fieldName` was fixed, so calling it on another model merged the wrong field. | Refuse when the model name does not match. |
| prisma  | JSON `null` was stringified to `"null"` rather than treated as empty. | Treat null/undefined as `{}`. |
| prisma  | **Lost updates**; 8 concurrent syncs left only **1** merge. | Compare-and-set `updateMany` + jittered-backoff retry. |
| prisma  | First CAS implementation livelocked under contention (1 of 8 writers exhausted its retries). | Randomized exponential backoff; default `maxRetries` 10. |

**Prior finding confirmed genuinely fixed:** `prisma/index.ts` no longer throws
an opaque error on a missing record — it raises a descriptive
`no <Model> record matches where {...}` error, asserted by
`test/prisma.test.ts`.

### Verified safe (not defects)

- **No SQL injection via identifiers.** Kysely quotes the column via `sql.ref`
  (a hostile name becomes a quoted identifier Postgres rejects); TypeORM
  validates against `/^[A-Za-z_][A-Za-z0-9_]*$/` before building SQL. Tested
  with `doc"; drop table ...; --` — the table survives.
- **No SQL injection via JSON content.** The merged document travels as a bound
  parameter everywhere. Quotes, semicolons, backslashes and `--` in the data
  round-trip verbatim.
- **Merge options really reach the C core.** Each suite asserts that dropping
  the policy *changes the outcome* (the stale element wins, `createdAt` is
  overwritten), and that a non-default `arrayMatchKeys` matches on that key.

---

## What is NOT covered

- **Postgres only.** Every test targets Postgres `jsonb`. MySQL/MariaDB `JSON`,
  SQLite and CockroachDB are untested; the `::text` projections and
  `CAST(... AS jsonb)` casts are Postgres-specific.
- **Drizzle has no transactional helper.** `performZeroDeserializationMerge` is
  in-memory by design, so drizzle users must supply their own locking (e.g. a
  transaction with `.for('update')`). There is no drizzle equivalent of
  `kyselySyncJsonb`, and therefore no drizzle lost-update test.
- **Drizzle dialects other than `node-postgres`.** Only
  `drizzle-orm/node-postgres` is exercised; not `postgres.js`, neon, or bun-sql.
- **Prisma is not zero-deserialization.** Prisma deserializes `jsonb` to a JS
  object, so the "keep it as a string" goal is unreachable through its model
  API. `syncJsonField` also always reads the *full* record.
- **Prisma CAS on nullable columns without `dbNull`.** Falls back to a plain
  `update`, leaving a narrow lost-update window on the NULL → first-document
  transition only.
- **No cross-process concurrency tests.** The lost-update tests use concurrent
  promises/goroutines against one pool. Row locks are real Postgres locks so the
  result should hold across processes, but that is not directly asserted.
- **No deadlock, lock-timeout, or retry-exhaustion-under-load testing**, and no
  performance/throughput benchmarks.
- **`maxDepth`, `detectCircularRefs`** are forwarded but not asserted here (the
  core's own suite covers them).
- **TypeORM decorator entities.** Tests use `EntitySchema` to avoid needing
  `experimentalDecorators`; decorator-defined entities are not exercised.
- **`SyncerJsonbTransformer`** is only checked to be an identity transformer; it
  is not wired into a live entity column.

---

## Related

- `syncer.c/core/include/syncer.h` — the C API and merge-policy vocabulary.
- `syncer.c/bindings/typescript/` — `mergeJson`, `ArrayStrategy`, `version`,
  `BaseMergeStrategy`.
- `syncer.c/plugins/go/gorm/` — the same policy for GORM, with its own
  Postgres-backed test suite.
