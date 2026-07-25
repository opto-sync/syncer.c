# ORM plugins

Nine adapters route a JSON/JSONB column through the merge engine so a concurrent
write **reconciles** with the stored document instead of overwriting it.

The merge rules are in [`MERGE_SEMANTICS.md`](./MERGE_SEMANTICS.md); the
per-language call surface is in [`BINDINGS.md`](./BINDINGS.md). This document is
about what each plugin does to your database, and — most importantly — **who is
responsible for locking**.

Read the concurrency section before the usage sections. A plugin that merges
correctly and loses the merge to a concurrent writer is worse than no plugin,
because the data loss is silent.

## The canonical policy

Every binding and plugin uses the same option set:

| Option | Value |
|---|---|
| array strategy | `MERGE_BY_KEY` (4) |
| array match keys | `"id"` |
| resolve by timestamp | `true` |
| LWW keys | `"updatedAt,syncedAt"` |
| FWW keys | `"createdAt"` |

Spelled per language: `POLICY` in `plugins/typescript/test/fixtures.ts`,
`ReconcileOptions::default()` in the three Rust crates, `canonicalOptions()` in
`plugins/go/gorm/syncer_test.go`, `Syncer.crdt_options/0` (re-exported as
`OptoSyncEcto.crdt_options/1`) on the BEAM.

## Inventory

| Plugin | Path | Public API | Touches the DB? | Locking |
|---|---|---|---|---|
| drizzle | `plugins/typescript/drizzle/index.ts` | `syncedJsonb()`, `performZeroDeserializationMerge()` | **no** — in-memory only | **caller's job** |
| kysely | `plugins/typescript/kysely/index.ts` | `kyselySyncJsonb()`, `SyncerRowNotFoundError` | yes, read+write | `FOR UPDATE` in a transaction |
| typeorm | `plugins/typescript/typeorm/index.ts` | `typeOrmSyncMerge()`, `SyncerJsonbTransformer()`, `SyncerRowNotFoundError` | yes, read+write | `setLock('pessimistic_write')` in a transaction |
| prisma | `plugins/typescript/prisma/index.ts` | `withSyncer()` → `model.syncJsonField()` | yes, read+write | compare-and-set + jittered retry |
| diesel | `plugins/rust/diesel/src/lib.rs` | `reconcile_jsonb()`, `reconcile_values()`, `ReconcileOptions` | **no** | **caller's job** |
| sqlx | `plugins/rust/sqlx/src/lib.rs` | same three symbols | **no** | **caller's job** |
| seaorm | `plugins/rust/seaorm/src/lib.rs` | same three symbols | **no** | **caller's job** |
| gorm | `plugins/go/gorm/syncer.go` | `SyncerPlugin{Options, Columns}` via `db.Use()` | yes, reads inside the update hook | `SELECT … FOR UPDATE`, **only useful if the caller opens a transaction** |
| ecto | `plugins/beam/ecto/lib/ecto_syncer.ex` | `merge_jsonb/3`, `merge_value/3`, `crdt_options/1`, `engine_version/0` | **no** — operates on a changeset | **caller's job** |

`plugins/dart/drift` also exists but is a **stub**: `SyncerInterceptor.runUpdate`
forwards to the executor unchanged and the binding import is commented out. It
performs no merge. It is not one of the nine and has no tests.

---

## Concurrency: who protects you, and who does not

Read-modify-write is the shape of every one of these plugins: read the stored
document, merge the incoming one on top, write the result. Without a lock, two
writers read the same base and the second write erases the first writer's
contribution. This is not theoretical — it was measured, fixed, and pinned by
regression tests for four of the nine plugins.

### Three tiers

| Tier | Plugins | What you must do |
|---|---|---|
| **Protects you** | kysely, typeorm, prisma | Nothing extra. Optionally pass your own transaction. |
| **Protects you only inside a caller transaction** | gorm | Wrap the update in `db.Transaction(...)`. Outside one, merges are lost. |
| **Cannot protect you** | drizzle, diesel, sqlx, seaorm, ecto | Provide the lock yourself: `SELECT … FOR UPDATE` in a transaction, or an optimistic lock. |

### Measured lost-update fixes

From `plugins/typescript/README.md`'s defect table and the tests that pin each
fix (each was verified to fail against the unfixed code):

| Plugin | Symptom before the fix | Fix | Test |
|---|---|---|---|
| kysely | 8 concurrent syncs left only **2** merges | one transaction + `FOR UPDATE`; reuses a caller transaction | `kysely.test.ts` — *"DEFECT: concurrent syncs of one row do not lose a merge (FOR UPDATE lock)"* |
| typeorm | 4 of 8 merges lost, *even inside a transaction* | transaction + `setLock('pessimistic_write')` | `typeorm.test.ts` — *"…(pessimistic_write)"* |
| prisma | 8 concurrent syncs left only **1** merge | compare-and-set `updateMany` + retry | `prisma.test.ts` — *"…(CAS + retry)"* |
| prisma | first CAS livelocked (1 of 8 writers exhausted retries) | randomized exponential backoff, `maxRetries` default 10 | same test asserts **zero** rejected writers |

Each of those three tests starts from `{"items":[]}`, fires 8 concurrent writers
each adding a distinct keyed element, and asserts all 8 elements are present in
the row re-read over an independent raw `pg` connection.

### drizzle: in-memory only, no transactional support — confirm this before adopting

**Confirmed from the code and the tests.** `plugins/typescript/drizzle/index.ts`
contains exactly two exports:

- `syncedJsonb(name, strategy)` — a Drizzle `customType` producing a real
  `jsonb` column. `fromDriver` parses only when the driver actually returned
  text (node-postgres already parses json/jsonb); `toDriver` passes a string
  through verbatim and stringifies anything else. No merging happens here.
- `performZeroDeserializationMerge(rawDbJson, rawIncomingJson, strategy, options?)`
  — calls `mergeJson` and `JSON.parse`s the result. **It issues no SQL at all:
  no SELECT, no UPDATE, no transaction, no lock.**

Consequences, stated plainly:

- The read-modify-write cycle is entirely in your code, so **the lost-update
  window is entirely yours**. Take the row lock yourself:

  ```ts
  await db.transaction(async (tx) => {
    const [row] = await tx
      .select({ raw: sql<string>`${docs.doc}::text` })
      .from(docs)
      .where(eq(docs.id, id))
      .for('update');                                  // ← the lock you must add
    const merged = performZeroDeserializationMerge(row.raw, incomingRaw, strategy, POLICY);
    await tx.update(docs).set({ doc: merged }).where(eq(docs.id, id));
  });
  ```

- There is **no drizzle lost-update test**, because there is no drizzle code path
  that could pass or fail one — `plugins/typescript/README.md` lists this under
  "What is NOT covered", and the nine tests in `drizzle.test.ts` are about column
  typing, merge correctness, persistence, idempotency, override reach, option
  forwarding, and error handling. None of them is concurrent.
- `performZeroDeserializationMerge` returns a **parsed object**, so writing it
  back through `.set({ doc: merged })` stringifies it again. If you want the
  truly zero-deserialization path, keep the raw string (`mergeJson` directly, or
  do not parse) and hand the string to `.set()` — `toDriver` passes strings
  through verbatim and Postgres casts the text parameter to `jsonb`. The
  end-to-end test in `drizzle.test.ts` writes the parsed object.
- Verified here: `performZeroDeserializationMerge` reconciles per the canonical
  policy and converts a core `null` into
  `Error: opto-sync merge failed: input was not valid JSON`.

### The Rust crates and Ecto are libraries, not gatekeepers

- **diesel / sqlx / seaorm** expose two pure functions (`reconcile_jsonb` on
  `&str`, `reconcile_values` on `serde_json::Value`) and never touch a
  connection. The sqlx doc comment shows the correct shape — `SELECT … FOR
  UPDATE` inside a transaction, reconcile, `UPDATE`, commit — and that is the
  pattern to copy for all three. The diesel and seaorm doc examples omit the
  lock; treat that as example brevity, not permission.
- **ecto** merges against `changeset.data`, i.e. whatever the row looked like when
  you loaded it. `plugins/beam/ecto/README.md` says it directly: merging fixes
  lost updates *within a document*, not *across transactions*. Wrap the
  read-merge-write in a transaction with `SELECT … FOR UPDATE`, or add
  `Ecto.Changeset.optimistic_lock/2`. The integration test named
  *"two writers touching different keys do not clobber each other"* is
  **sequential** — each writer re-reads before merging. There is no concurrent
  Ecto test.

### gorm: the lock is real, but only if you open a transaction

`SyncerPlugin` registers a `Before("gorm:update")` callback. For map-based
`Updates()` it locates JSON/JSONB columns, reads the current value with
`clause.Locking{Strength: "UPDATE"}` on the **same connection** as the update
being intercepted (`Session{NewDB: true}` preserves the ConnPool), merges, and
substitutes the merged document into the update map.

Outside a transaction each statement is its own implicit transaction, so the
`FOR UPDATE` lock is released before the `UPDATE` runs. Both behaviors are
pinned:

| Test | Asserts |
|---|---|
| `TestConcurrentUpdatesLoseWrites` | the bare form loses merges (deliberately weak assertion: at least one writer survives, with a `t.Logf` diagnostic; the README reports "typically keeps only 2" of 8) |
| `TestConcurrentUpdatesInTransactionAreSafe` | the transaction-wrapped form keeps **all 8** and every writer element is present |

```go
// SAFE — the lock is held until commit.
db.Transaction(func(tx *gorm.DB) error {
    return tx.Model(&Doc{ID: id}).
        Updates(map[string]any{"data": incomingRawJSON}).Error
})
```

Two more gorm behaviors to know, both pinned by tests:

- **Struct-based updates are passed through unmerged.** GORM omits zero fields
  for struct updates, so "unset" and "overwrite" are indistinguishable
  (`TestStructUpdatesPassThrough`).
- **Unscoped updates are not merged — but they still run.** With no WHERE clause
  and no primary key the plugin refuses to merge rather than merge against an
  arbitrary row; the `UPDATE` itself proceeds and overwrites every matched row
  with the incoming document as-is (`TestUnscopedUpdateIsNotMerged`). The guard
  rail prevents merging the *wrong* row; it does not turn an unscoped update into
  an error.

### Zero-deserialization

"Zero-deserialization" means the document stays as JSON text from the database
driver into the C core and back, deserializing at most once at the end.

| Plugin | Zero-deserialization | Why |
|---|---|---|
| drizzle | yes (with a caveat) | reads `doc::text`, merges text; `performZeroDeserializationMerge` then parses once. Keep the raw string to skip even that. |
| kysely | yes | `SELECT <col>::text`, merge, `CAST($1 AS jsonb)`; returns the merged **string** |
| typeorm | yes | `SELECT entity.col::text`, merge, `CAST(:mergedJson AS jsonb)`; returns the merged **string** |
| **prisma** | **no** | Prisma deserializes `jsonb` to a JS object, so the plugin must `JSON.stringify` it in and `JSON.parse` it out; it also always reads the **full** record. Confirmed in `prisma/index.ts` (the code comments say so) and listed under "What is NOT covered". |
| diesel / sqlx / seaorm | either | `reconcile_jsonb` is text-in/text-out; `reconcile_values` costs a `to_string()` + `from_str()` round trip because the ORM handed you a `Value` |
| gorm | yes | scans the column into `[]byte`, merges text, writes the merged string |
| ecto | no | encodes with `Jason` and decodes again, unless the incoming change *is* raw JSON text (then binary in → binary out, no decode) |

---

## Usage

### drizzle-orm

```ts
import { eq, sql } from 'drizzle-orm';
import { syncedJsonb, performZeroDeserializationMerge } from './plugins/typescript/drizzle';

const docs = pgTable('docs', {
  id: text('id').primaryKey(),
  doc: syncedJsonb<Doc>('doc', new PassthroughStrategy()),
});

// see the locking snippet above — wrap this in a transaction with .for('update')
const merged = performZeroDeserializationMerge<Doc>(rawFromDb, incomingRaw, strategy, POLICY);
await db.update(docs).set({ doc: merged }).where(eq(docs.id, id));
```

Only `drizzle-orm/node-postgres` is exercised. `strategy` is a
`BaseMergeStrategy` subclass; the plugin calls `strategy.toNativeCallback()` for
you.

### kysely

```ts
const persisted: string = await kyselySyncJsonb(
  db,            // Kysely instance OR an existing transaction
  'docs',        // table
  'id',          // id column
  id,            // id value
  'doc',         // jsonb column
  incomingRaw,   // raw JSON string
  strategy,
  POLICY,
);
```

Opens its own transaction unless `db.isTransaction` is already true, in which
case it joins yours and the lock lives until *your* commit (pinned by a test that
rolls back and asserts the merge was undone). Throws `SyncerRowNotFoundError`
when no row matches, and again if the `UPDATE` reports `numUpdatedRows === 0`. A
SQL `NULL` column is treated as `{}`. The column identifier goes through
`sql.ref`, so it cannot inject SQL; the merged document travels as a bound
parameter.

### typeorm

```ts
const persisted: string = await typeOrmSyncMerge(
  repo, id, 'doc', incomingRaw, strategy, POLICY /*, idColumn = 'id' */,
);
```

Note the argument order: `idColumn` comes **after** the options and defaults to
`'id'`. Entities keyed otherwise must pass it (a test asserts the default fails
loudly on such an entity, and that the explicit form works). `columnName` and
`idColumn` are validated against `/^[A-Za-z_][A-Za-z0-9_]*$/` before reaching
SQL. Runs through `repository.manager.transaction(...)`, which joins an active
caller transaction. `SyncerJsonbTransformer()` is an identity
`ValueTransformer` only — it is not wired into the merge path and is only
checked to be an identity transformer.

### prisma

```ts
import { Prisma } from '@prisma/client';

const xprisma = prisma.$extends(
  withSyncer('Doc', 'doc', strategy, POLICY, { dbNull: Prisma.DbNull, maxRetries: 10 }),
);
await xprisma.doc.syncJsonField({ id }, incomingRaw);   // returns the reloaded record
```

Prisma's model API cannot express `SELECT … FOR UPDATE`, so the write is an
`updateMany` whose `WHERE` also requires the field to still equal the value the
merge was computed from (compare-and-set), retried with randomized exponential
backoff up to `maxRetries` (default 10) before throwing a descriptive
write-contention error.

Two sharp edges:

- Pass `dbNull: Prisma.DbNull` if the column is **nullable**. Prisma cannot
  filter on "is still SQL NULL" without that sentinel, and
  `@prisma/client/extension` does not re-export it. Without it the CAS is
  skipped for currently-NULL rows and a plain `update` is used, leaving a narrow
  lost-update window on the NULL → first-document transition.
- `withSyncer` attaches `syncJsonField` to `$allModels` while `fieldName` is
  fixed at configuration time, so calling it on another model is **refused** with
  an error telling you to apply a separate extension per model.

### diesel / sqlx / seaorm

Identical surface in all three crates (`opto-sync-diesel`, `opto-sync-sqlx`,
`opto-sync-seaorm`):

```rust
use opto_sync_sqlx::{reconcile_jsonb, reconcile_values, ReconcileOptions};

let opts = ReconcileOptions::default();          // the canonical policy
let merged: String = reconcile_jsonb(&current_text, &incoming_text, &opts)?;
let merged: serde_json::Value = reconcile_values(&current_value, &incoming_value, &opts)?;
```

`ReconcileOptions` fields: `array_strategy`, `array_match_keys`,
`resolve_by_timestamp`, `lww_keys`, `fww_keys`, `max_depth`. Note the defaults
are **not** `MergeOptions::default()` from `syncer-rs` — they are the canonical
CRDT policy (`MergeByKey` on `"id"`, timestamps on, `updatedAt,syncedAt` LWW,
`createdAt` FWW). `detect_circular_refs` is hard-coded `false` and there is no
override-callback surface (the Rust binding has none).

Failure is `Err(ReconcileError::InvalidJson)` — one variant, covering invalid
JSON, an interior NUL byte, and a result that will not deserialize.

### gorm

```go
db.Use(&syncer_gorm.SyncerPlugin{
    Options: syncer.Options{
        ArrayStrategy:      syncer.ArrayMergeByKey,
        ArrayMatchKeys:     "id",
        ResolveByTimestamp: true,
        LwwKeys:            "updatedAt,syncedAt",
        FwwKeys:            "createdAt",
    },
    // Columns: []string{"doc"},  // default: every field whose DataType is json/jsonb
})

db.Transaction(func(tx *gorm.DB) error {
    return tx.Model(&Doc{ID: "doc-1"}).
        Updates(map[string]any{"doc": `{"nested":{"x":1}}`}).Error
})
```

`Columns` matches on either the DB column name or the Go field name. Incoming
values may be a `string`, `[]byte`, `json.RawMessage`, or anything
`json.Marshal` accepts. Merge and fetch errors are reported via `db.AddError`,
which aborts the update. Nothing stored yet (no row, or an empty value) means the
update is written as-is.

### ecto

```elixir
def changeset(doc, attrs) do
  doc
  |> Ecto.Changeset.cast(attrs, [:metadata, :items])
  |> OptoSyncEcto.merge_jsonb([:metadata, :items], OptoSyncEcto.crdt_options())
end

OptoSyncEcto.merge_value(base, incoming, opts \\ [])  # {:ok, value} | {:error, :merge_failed}
OptoSyncEcto.engine_version()                         # core version string
```

Rules, in order (from `lib/ecto_syncer.ex`):

1. No change for the field → untouched.
2. The change is `nil` (a deliberate NULL-out), or the stored value is `nil`/`""`
   → untouched; the cast value stands alone.
3. Otherwise: encode both sides, merge natively, `put_change/3` the result.
4. A merge failure becomes a **changeset error** on that field
   (`validation: :opto_sync_merge`, default message
   `"could not be merged with the stored document"`, overridable with
   `:message`) — never a raise, so a malformed payload is a 422 and `Repo.update/1`
   returns `{:error, changeset}` with the row untouched.

The result keeps the **shape of the incoming change**: map/list in → decoded
value out (for `:map` / `{:array, :map}` columns), binary in → JSON text out (for
`:string`/`:binary` columns holding raw JSON), so the field is still dumped by
the same `Ecto.Type`. Options are validated eagerly through
`Syncer.normalize_options/1`, so a typo raises `ArgumentError` at the call site
instead of silently reconciling with the wrong policy. It is a changeset function
rather than an `Ecto.Type` because `cast/1` and `dump/1` only ever see the
incoming value, and merging needs the stored one too.

---

## Two core-semantics traps

Both are core behaviors, not plugin bugs, and both are (or were) pinned by
`plugins/typescript/test/core-contract.test.ts`.

### 1. Timestamp resolution is wholesale per object node

If both sides of an object carry an `lwwKeys`/`fwwKeys` key, the **entire**
incoming object node is accepted or rejected — the merge does not descend to
compare individual keys. Verified here by running that test file's
*"object-level timestamp resolution is WHOLESALE, not per-key"* case (it passes):

```js
mergeJson('{"updatedAt":"2026-06-01","keep":1}',
          '{"updatedAt":"2026-05-01","add":2}', POLICY)
// -> {"updatedAt":"2026-06-01","keep":1}      ← "add" never lands
```

**A root-level `updatedAt` therefore gates the whole document**, and a
root-level `createdAt` under FWW freezes it against any later write. Put
timestamps at the level whose reconciliation you actually want — typically on
each keyed array element and on each independently-editable subtree. This is why
`plugins/typescript/test/fixtures.ts` deliberately keeps the root free of
timestamp keys.

Consequences for strategy choice:

- With `MERGE_BY_KEY`, timestamps on each element give you per-record LWW/FWW,
  which is what makes a stale element reject while a fresh sibling in the same
  array applies.
- With `REPLACE`, timestamps buy you little inside arrays: the array is taken
  wholesale, so per-element staleness is unrepresentable.
- If a whole subtree really is one unit of concurrency (a versioned settings
  blob, say), a single `updatedAt` on that subtree is the right design — just
  know that no field under it can be merged independently.

### 2. The override callback DOES reach arrays as of core 0.2.1

Older comments in this tree say the opposite. **They are stale.** Verified three
ways:

- `core/src/syncer.c`: `try_override_node` is called from three sites — the root
  (line 672, including a root-level array at path `$`), the object-value leaf
  path (763), and the object-value composite path (788) — *before* the array
  strategy descends. Nothing in the array handling skips it.
- `core/test/test_syncer.c::test_override_reaches_arrays` loops over **all five**
  strategies and asserts the callback fired exactly once for the array node and
  that the host's replacement won. It passes: `cd core && make` →
  `44/44 passed`.
- Through the TypeScript binding, with the canonical policy:

  ```
  REPLACE         tags=[host-decided]  paths: $.tags $.rows
  APPEND          tags=[host-decided]  paths: $.tags $.rows
  UNION           tags=[host-decided]  paths: $.tags $.rows
  MERGE_BY_INDEX  tags=[host-decided]  paths: $.tags $.rows $.rows[0].id $.rows[0].v
  MERGE_BY_KEY    tags=[host-decided]  paths: $.tags $.rows $.rows[0].id $.rows[0].v
  ```

So an override registered for an array path (e.g. a custom `tags` union or an
`embedding` average, as in `BaseMergeStrategy.ts`'s `UserProfileMerger` example)
**does** fire under the canonical `MERGE_BY_KEY` policy. What still differs per
strategy is how deep the callback goes *inside* an array: `MERGE_BY_INDEX` and
`MERGE_BY_KEY` pair elements and consult the callback for keys within matched
elements, while `REPLACE`/`APPEND`/`UNION` never pair elements and so only offer
the array node itself.

**Two tests in `plugins/typescript/test/core-contract.test.ts` are now stale and
fail against core 0.2.1.** Measured by running that suite standalone (it needs no
database) — 6 of 8 tests pass, 5 assertions fail:

| Failing test | Assertion | Actual |
|---|---|---|
| *"core is v0.2.0 and exposes MERGE_BY_KEY = 4"* | `version() === '0.2.0'` | `0.2.1` |
| *"override callback is NOT consulted for arrays under UNION/MERGE_BY_KEY"* | callback not called for `$.tags`; array reconciled to `['a','b']` | callback **is** called for both strategies; result `['OVERRIDDEN']` |

The DB-backed expectations are unaffected: re-running the
`fixtures.ts` merge under 0.2.1 reproduces `EXPECTED_MERGED` and
`EXPECTED_MERGED_WITH_OVERRIDE` exactly (`OverrideStrategy` now *sees*
`tags`/`embedding` but declines them, so the outcome is unchanged).
`plugins/typescript/README.md` §"Two sharp edges" item 2 and the
`OverrideStrategy` doc comment in `fixtures.ts` carry the same stale claim.

---

## Choosing options for your schema

Start from the canonical policy and change it only with a reason.

### Array strategy for a jsonb column

| Your array is… | Use | Notes |
|---|---|---|
| a set of records with stable identities (line items, tags-with-ids, participants) | `MERGE_BY_KEY` + `arrayMatchKeys` | the default; per-element LWW/FWW, idempotent, order-insensitive matching |
| a set of scalars where duplicates are meaningless (labels, feature flags) | `MERGE_BY_KEY` or `UNION` | non-object elements fall back to UNION semantics under `MERGE_BY_KEY`, so one policy covers both shapes in one document |
| a fixed-length positional vector (an embedding, RGB triple, matrix row) | `MERGE_BY_INDEX` | pairs by position; the longer side is preserved |
| an append-only log you own end-to-end and never re-send | `APPEND` | **not idempotent, by design** — a retried sync duplicates elements. Only safe with exactly-once delivery. |
| an opaque value the client owns wholesale (a UI layout snapshot) | `REPLACE` | the default in the core, and the honest choice when there is no element identity |

`arrayMatchKeys` takes a comma-separated list and the **first key present in the
incoming element** is its identity, so `"uuid,id"` means "prefer the uuid, fall
back to the id". Identity is value-normalized: `42` matches `"42"`. The contract
is one identity value per array; duplicates bind to the first match and make
results unstable.

### Why `MERGE_BY_KEY` + LWW `updatedAt,syncedAt` + FWW `createdAt` is the default

- **`MERGE_BY_KEY`** is the only strategy that reconciles *records* inside a
  jsonb column: a stale element is rejected while a fresh sibling in the same
  array is applied and an unseen id is appended. `REPLACE` would drop the
  sibling; `APPEND` would duplicate on retry; `UNION` cannot merge two versions
  of the same record; `MERGE_BY_INDEX` breaks the moment either side reorders or
  changes length.
- **LWW on `updatedAt,syncedAt`** rejects a stale client write per record instead
  of per document. Two keys, because `updatedAt` is the application's edit clock
  and `syncedAt` is the transport's; a key participates only when **both** sides
  carry it, so listing both is free.
- **FWW on `createdAt`** protects the original creation record: an incoming
  element with a *newer* `createdAt` is a re-creation attempt and loses. Without
  it, a client replaying an old create can rewrite provenance.
- **Idempotency**: with this policy, re-applying the same payload converges
  (`merge(merge(a,b), b) == merge(a,b)`), which is what makes a retried sync
  safe. Every plugin suite asserts it, and the core's `prop_test.c` asserts it
  over randomized document pairs.

Two practical constraints from `MERGE_SEMANTICS.md` worth repeating because they
bite at the schema-design stage:

- Use **one timestamp format per key** across all replicas. Mixing epoch numbers
  and ISO-8601 strings compares lexicographically and is not chronologically
  meaningful.
- Represent sub-millisecond timestamps as **digit strings**. Integers past 2^53
  are rounded by any JavaScript host — including `express.json` — while digit
  strings are exact everywhere and still compare numerically.

And one design rule that follows from trap 1: give independently-editable
records their own identity and their own timestamp. Two mutations gated by the
*same* node's `updatedAt` are order-dependent by construction.

---

## Status and test coverage, per plugin

Honest version. "Integration" means a real ORM package against a real Postgres
with persistence re-read over an independent connection.

| Plugin | Status | Test suite | Kind | Concurrency test | Run in CI? |
|---|---|---|---|---|---|
| drizzle | implemented | `plugins/typescript/test/drizzle.test.ts` (9 tests) | integration (Postgres + `pg` + real `drizzle-orm/node-postgres`) | **none possible** — helper is in-memory | no (type-check only) |
| kysely | implemented | `test/kysely.test.ts` (15 tests) | integration | **yes** — 8 writers, `FOR UPDATE` | no (type-check only) |
| typeorm | implemented | `test/typeorm.test.ts` (15 tests) | integration | **yes** — 8 writers, `pessimistic_write` | no (type-check only) |
| prisma | implemented | `test/prisma.test.ts` (14 tests + a skip guard) | integration (real generated client) | **yes** — 8 writers, CAS + retry | no (type-check only) |
| core contract | — | `test/core-contract.test.ts` (8 tests) | no DB needed, but the runner waits for Postgres first | n/a | no |
| diesel | implemented | `plugins/rust/diesel/src/lib.rs` `#[cfg(test)]` (3 tests) | **unit only** — no Diesel, no database | no | **yes** (`cargo test`) |
| sqlx | implemented | `plugins/rust/sqlx/src/lib.rs` (4 tests) | **unit only** — no sqlx, no database | no | **yes** |
| seaorm | implemented | `plugins/rust/seaorm/src/lib.rs` (4 tests) | **unit only** — no SeaORM, no database | no | **yes** |
| gorm | implemented | `plugins/go/gorm/syncer_test.go` (19 tests) | integration (real `gorm.io/driver/postgres`) | **yes** — both the losing and the safe form | partly — CI runs `go build` + `go vet` only |
| ecto | implemented | `plugins/beam/ecto/test/opto_sync_ecto_test.exs` (22 tests + 3 doctests, hermetic) and `test/postgres_integration_test.exs` (4 tests, tagged `:integration`, excluded by default) | changeset unit tests + opt-in integration | **no** — the "two writers" test is sequential | **no** — no BEAM job exists in `.github/workflows/ci.yml` |

Test counts above are `test(...)` / `#[test]` / `func Test…` declarations counted
in the files named.

### Verified by running

| Command | Result |
|---|---|
| `cd plugins/rust/diesel && cargo test` | 3 passed, 0 failed (1 doc-test ignored) |
| `cd plugins/rust/sqlx && cargo test` | 4 passed, 0 failed (1 ignored) |
| `cd plugins/rust/seaorm && cargo test` | 4 passed, 0 failed (1 ignored) |
| `cd plugins/go/gorm && go test ./...` | `ok` — **all 19 tests SKIP** without Postgres (`t.Skipf` in `openDB`) |
| `cd plugins/typescript && npm run typecheck` | both configs clean (stubs + real packages) |
| `plugins/typescript/test/core-contract.test.ts` via a standalone runner | 6/8 tests pass; 5 assertions fail (stale version + stale array-override claim) |
| the `fixtures.ts` policy merge, with and without `OverrideStrategy` | reproduces `EXPECTED_MERGED` / `EXPECTED_MERGED_WITH_OVERRIDE` byte-for-byte under 0.2.1 |
| `performZeroDeserializationMerge` (drizzle helper, in-memory) | reconciles per policy; invalid JSON → descriptive throw |

**Not run here:** every DB-backed suite (drizzle, kysely, typeorm, prisma, gorm)
— they need a Postgres instance, which was deliberately not started; and both
Ecto suites, because `mix`/`elixir` are not installed on this machine (the
BEAM toolchain lives in `bindings/beam/Dockerfile.test`). The commands are
documented below unchanged from the plugin READMEs.

```bash
# TypeScript plugin suites
docker run -d --name plugintest-pg -p 127.0.0.1:55987:5432 \
  -e POSTGRES_PASSWORD=test -e POSTGRES_USER=test -e POSTGRES_DB=plugintest \
  postgres:16-alpine
cd syncer.c/plugins/typescript
npm install
npm run prisma:generate          # once; the prisma suite skips loudly without it
npm test                         # typecheck, then core + drizzle + kysely + typeorm + prisma
# single suite: npm run test:drizzle | test:kysely | test:typeorm | test:prisma
# DSN override: OPTO_SYNC_TEST_PG

# GORM
cd syncer.c/plugins/go/gorm && go test ./... -v

# Ecto (hermetic, then integration) — image from bindings/beam
docker run --rm -v "$PWD":/src -w /src/plugins/beam/ecto opto-sync-beam-test \
  sh -c 'mix deps.get && mix test'
# ... mix test --include integration    with PG_URL set
```

The native addon must be built before the TypeScript suites:
`cd syncer.c/bindings/typescript && npm install`.

### What is not covered anywhere

- **Postgres only.** Every integration test targets Postgres `jsonb`. MySQL /
  MariaDB `JSON`, SQLite and CockroachDB are untested, and the `::text`
  projections and `CAST(… AS jsonb)` casts are Postgres-specific.
- **No drizzle transactional helper, and therefore no drizzle lost-update test.**
- **Drizzle dialects other than `node-postgres`** — not `postgres.js`, neon, or
  bun-sql.
- **No concurrency test at all for diesel, sqlx, seaorm, or ecto**, and no
  database test for the three Rust crates.
- **No cross-process concurrency tests.** The lost-update tests use concurrent
  promises/goroutines against one pool. Row locks are real Postgres locks so the
  result should hold across processes, but that is not asserted.
- **No deadlock, lock-timeout, or retry-exhaustion-under-load testing**, and no
  throughput benchmarks.
- **`maxDepth` and `detectCircularRefs`** are forwarded by the plugins but
  asserted only in the core's own suite.
- **TypeORM decorator entities** — tests use `EntitySchema` to avoid needing
  `experimentalDecorators`.
- **`SyncerJsonbTransformer`** is only checked to be an identity transformer; it
  is never wired into a live entity column.
- **Prisma CAS on nullable columns without `dbNull`** — falls back to a plain
  `update`, leaving a lost-update window on the NULL → first-document transition.
- **CI runs no DB-backed plugin test.** The `plugins` job runs `cargo test` for
  the three Rust crates, `tsc --noEmit` for the TypeScript plugins, and
  `go build` + `go vet` for gorm. There is no wasm job and no BEAM job.

## Documentation drift found while verifying (reported, not fixed)

| Where | Claim | Reality |
|---|---|---|
| `plugins/typescript/test/core-contract.test.ts` | `version() === '0.2.0'`; the override callback is not consulted for arrays under `UNION`/`MERGE_BY_KEY` | core is `0.2.1`; the callback reaches arrays under every strategy — 2 tests / 5 assertions fail |
| `plugins/typescript/README.md` §"Two sharp edges" item 2 | same array-override claim, plus "under the canonical policy that override never fires" | it does fire |
| `plugins/typescript/test/fixtures.ts` (`OverrideStrategy` doc comment) | same claim ("verified against core v0.2.0") | stale; the expected documents themselves are still correct |
| `plugins/typescript/README.md`, `plugins/*/README.md`, plugin module docs | "the `syncer.c` core (v0.2.0)" / `engine_version() #=> "0.2.0"` | `0.2.1` |
| `.github/workflows/ci.yml` (plugins job comment) | "plugins/typescript has no package.json, so there is nothing to install first" | it has a `package.json` with real devDependencies and five test scripts; CI simply chooses not to install them |
| `.github/workflows/ci.yml` (plugins job comment) | "the TypeScript plugins are type-check only" | true *of CI*, but the suites are real integration tests — worth not reading as "no integration tests exist" |
| `plugins/dart/drift/README.md` | "Add `SyncerInterceptor` to your database connection" | the interceptor is a stub that merges nothing |
