# Troubleshooting

Every entry below is a failure that actually occurred while building or testing
opto-sync, with the symptom you would see and the reason. They are ordered by
how likely you are to hit them.

## "My change to the core had no effect"

**Symptom.** You edit `core/src/syncer.c`, tests still pass, behavior is
unchanged — or worse, TypeScript and Go disagree with C, Dart, and Rust.

**Cause.** Two toolchains do not track the core's C sources as dependencies:

- **node-gyp** does not rebuild `bindings/typescript/build/Release/syncer.node`
  when `core/src/*.c` changes.
- **Go's build cache** does not fingerprint the core sources, because
  `bindings/go/syncer_core.c` `#include`s them from outside the package.

So both can silently run an **outdated merge engine**.

**Fix.**

```sh
cd bindings/typescript && npx node-gyp rebuild
cd bindings/go && go clean -cache && go test -count=1 ./...
```

`test-differential/run_all.sh` handles this automatically. Committed WebAssembly
artifacts under `bindings/wasm/dist/` have the same exposure — rerun
`bindings/wasm/build.sh` after a core change.

**How to detect it.** Every binding exposes the core version. Assert it as a
**lower bound**, never an exact match: an exact pin fails on every patch bump
yet still passes against a stale artifact reporting an older version. A stale
addon was caught exactly this way.

```js
const [maj, min, patch] = version().split('.').map(Number);
assert.ok(maj > 0 || min > 2 || (min === 2 && patch >= 1));
```

## Merged output differs byte-for-byte after a database round trip

**Symptom.** You store a merged document, read it back, and a string comparison
fails. Repeated syncs look non-idempotent.

**Cause.** Postgres `jsonb` renormalizes object key order (to length, then
bytes) and drops duplicate keys. It is a value type, not a text type.

**Fix.** Compare **parsed values**, never text. Merge output is guaranteed
semantically stable across a jsonb round trip, never byte-stable. Use `json`
instead of `jsonb` only if you genuinely need byte fidelity — you lose
indexing and containment operators.

This also means `UNION` dedup cannot rely on serialized form; the core compares
structurally for exactly this reason (see
[MERGE_SEMANTICS.md](./MERGE_SEMANTICS.md)).

## Nanosecond timestamps come back wrong

**Symptom.** `1689940800123456789` becomes `1689940800123456800`. Stale writes
win, or last-write-wins picks the wrong side.

**Cause.** Integers beyond 2^53 cannot survive an IEEE-754 double. **Any**
JavaScript layer rounds them: a browser, `express.json`, `JSON.parse` in a test
harness. Rust and Dart preserve 64-bit integers exactly; Postgres `jsonb` is
exact.

**Fix.** Represent sub-millisecond timestamps as **digit strings**. The core
compares pure-digit strings numerically, so `"10"` correctly outranks `"9"` and
resolution stays correct.

```jsonc
{ "updatedAt": "1689940800123456789" }   // exact everywhere
{ "updatedAt": 1689940800123456789 }     // rounded by any JS host
```

Millisecond timestamps (13 digits) and ISO-8601 strings are unaffected. When
asserting numeric precision from a Node test, inspect the **raw response text** —
`JSON.parse` in the test process will itself round the value and make an exact
server look lossy.

## Concurrent writes to one record lose data

**Symptom.** Several clients sync the same record; some contributions vanish.

**Cause.** Read-modify-write with no lock. The merge is correct; the persistence
around it is not. Two writers read the same base, both merge, and the slower
write clobbers the faster one's result.

**Fix.** Either compare-and-swap on a version column with bounded retry and
full-jitter backoff, or hold a row lock (`SELECT … FOR UPDATE`) across the
read-merge-write. Without jitter, contending writers retry in lockstep and keep
colliding: a 5-attempt budget produced 25–60% conflicts at 20-way contention,
while 12 attempts with jitter absorbed the same load with zero lost writes.

Several ORM plugins had this bug; the ones that now lock are listed in
[PLUGINS.md](./PLUGINS.md). Not every plugin can protect you — some require you
to supply the transaction.

## Concurrent writes do not converge to the same state

**Symptom.** Applying the same set of mutations in a different order yields a
different document.

**Cause.** This is expected, not a bug, when mutations contend for the **same**
timestamped node. Resolution is per-node and all-or-nothing: if the base wins,
the entire incoming node is rejected, not just its conflicting fields. So
applying the older mutation first lets the newer one merge on top, while the
reverse rejects the older one wholesale.

**Fix.** Give independently-editable records their own identity and their own
timestamps — that is what `MERGE_BY_KEY` is for. Mutations touching distinct
keyed elements are order-independent. See the convergence section of
[MERGE_SEMANTICS.md](./MERGE_SEMANTICS.md).

## `npm install` fails building the native addon

**Symptom.** `MODULE_NOT_FOUND: node-addon-api`, or `'syncer.h' file not found`.

**Cause.** npm installs a `file:`-linked package as a symlink and does **not**
install that package's own dependencies, so the binding's `node-gyp rebuild`
runs without `node-addon-api` on its resolution path. Hoisting into the
consumer does not help (resolution walks up from the binding's real location),
a root `preinstall` hook runs too late (npm reifies the tree first), and
`install-links=true` breaks the binding's relative `../../core/src` includes.

**Fix.** In this repo the addon is an `optionalDependency` plus a `postinstall`
bootstrap that builds it in place. If you hit this in your own project, install
the binding's dependencies first:

```sh
cd path/to/syncer.c/bindings/typescript && npm install
```

Browsers do not need the native addon at all — the WebAssembly build requires no
toolchain.

## `mergeJson` returns null / an empty result

**Cause.** `NULL` means **one of the inputs was not valid JSON**. It is never a
successful empty merge; the distinction is deliberate and every binding
preserves it (`null` / `None` / `{:error, :merge_failed}` / an exception).

**Fix.** Check both inputs. A common source is stringifying `undefined`, or
selecting a column that was not fetched, which yields the string `"undefined"`.

Related: pass a real `NULL`/absent value rather than an empty string for
`lww_keys` and `array_match_keys`. The core reads absent `lww_keys` as
`"updatedAt"` and absent `array_match_keys` as `"id"`, while an empty string
means "no keys".

## An override callback never fires

**Cause.** Two possibilities. Either the binding does not support callbacks
(Rust, Go, and BEAM omit them deliberately), or you are on a core older than
0.2.1, where arrays skipped the callback entirely under every non-`REPLACE`
strategy — so a callback registered for an array path was silently ignored
under the default policy.

**Fix.** Upgrade to 0.2.1+, where objects, arrays, and root-level arrays all
consult the override before the strategy descends. Confirm your linked core with
`version()`.

## A jsonb array grows on every sync

**Cause.** `APPEND` is deliberately not idempotent, and it is easy to select by
accident. `UNION` and `MERGE_BY_KEY` are idempotent.

**Fix.** For arrays of records use `MERGE_BY_KEY` with an identity key. For sets
of scalars use `UNION`. If duplicates persist under `MERGE_BY_KEY`, your elements
probably lack the identity key (`array_match_keys`, default `"id"`) and are
falling back to union semantics — or the same identity appears twice in one
array, which is out of contract.

## Tests pass but never exercise the C core

**Symptom.** A green suite that proves nothing.

**Cause.** A JavaScript fallback merge. The reference e2e server used to fall
back silently when the addon was missing, so the entire suite could pass without
the core.

**Fix.** Fail closed. The reference server now refuses to boot without the
native addon (`SYNCER_REQUIRE_NATIVE=1`), and the suites assert
`/health` reports `"syncer":"native"`.

## Docker build is slow, or an image shadows in-image dependencies

**Cause.** The e2e build context is the **parent** directory, and Docker only
honors a `.dockerignore` at the context root. Without it, host `node_modules/`,
`target/`, and `build/` trees are uploaded and can shadow in-image installs.

**Fix.**

```sh
cp opto-sync-e2e/context.dockerignore /path/to/opto-sync/.dockerichore  # note: .dockerignore
```

Also: `rust-mash` is opt-in behind the `mash` profile because it is inert
without Supabase credentials. It only functions with a real project or the
PostgREST override.

## An e2e suite fails only when run twice

**Cause.** The in-memory e2e servers have no `/reset` and accumulate state
forever, so a suite reusing fixed keys compares a fresh server against one
carrying data from an earlier run. Conversely, `/reset` on the Postgres server
truncates shared tables, so a concurrent suite can have its fixtures deleted.

**Fix.** Namespace fixtures per run (the cross-server suite derives a namespace
from its pid) and create documents immediately before use.

## Leak checks report nothing on macOS

**Cause.** macOS ASan ships without LeakSanitizer, so `detect_leaks` is
unavailable — leaks are simply never reported.

**Fix.** Run leak checks on Linux via Docker; `core/test/fuzz/run_fuzz.sh` does
this. libFuzzer is likewise unavailable on macOS clang (the runtime archive is
not installed), so fuzzing also goes through a Linux image.
