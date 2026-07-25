# Changelog

All notable changes to the `syncer.c` core and the bindings, plugins and test
harnesses in this repository.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
the project follows [Semantic Versioning](https://semver.org/) as scoped in
[`docs/COMPATIBILITY.md`](docs/COMPATIBILITY.md#semantic-versioning-policy).

Dates are the commit dates of the release commits; there are no git tags in this
repository. `syncer_version()` is the authoritative version string and returns
`"0.2.1"` today.

---

## [0.2.1] — 2026-07-25

Version reported by `syncer_version()`. Includes the two fixes that landed
between 0.2.0 and this release (`318777c6`, `3d7e064c`) and were first shipped
under this version number.

### Fixed

- **Escaped-NUL keys aliased onto unrelated keys — data corruption.** JSON keys
  may legally contain an escaped NUL (RFC 8259), but keys were looked up and
  recreated with `strlen()`, truncating there. An incoming long key could
  therefore alias onto an unrelated shorter key, **overwriting that key's value
  and dropping the real key**. Key handling is now length-explicit throughout.
  Found while building the libFuzzer harnesses; pinned by
  `test_nul_in_key_not_truncated`.

- **`UNION` dedup depended on object key order — lost idempotency.** `UNION`
  deduplicated elements by `strcmp` of their serialized JSON, so dedup silently
  depended on key order, which no caller controls. Postgres `jsonb`
  renormalizes key order on every write, so a round-tripped `{"id":"c","v":3}`
  came back as `{"v":3,"id":"c"}` and never matched the element it duplicated:
  **`UNION` degraded to `APPEND` and lost idempotency for any multi-key
  object.** Replaced with iterative structural deep-equality (explicit heap
  stack, no C recursion): object keys compare as an unordered set, arrays stay
  order-sensitive, integers compare exactly while any pair involving a real
  compares as a double. On allocation failure it reports "not equal", so an
  element may be appended twice but is never corrupted. Found by the e2e
  conformance suite. Pinned by `test_union_dedup_key_order_independent`,
  `test_union_dedup_semantics` and `test_union_idempotent_after_reorder`.

  Shipped as a patch-level change even though results change, on the grounds
  that key-order-dependent dedup was never a usable contract — the exception is
  recorded in [`docs/COMPATIBILITY.md`](docs/COMPATIBILITY.md#semantic-versioning-policy).

- **Override callbacks never reached array nodes.** The callback was not
  consulted for ARRAY nodes under any non-`REPLACE` strategy, so a callback
  registered for an array path was **silently ignored under the default
  policy** — the same callback fired for `$.profile` but not for
  `$.profile.tags`. Objects, arrays and root-level arrays now share one code
  path (`try_override_node`). Pinned by `test_override_reaches_arrays`,
  `test_override_reaches_root_array` and
  `test_override_declining_leaves_strategy_intact`.

- **Float timestamps bypassed LWW/FWW resolution entirely.** A numeric
  timestamp pair involving a real — e.g. fractional epoch seconds from
  `time.time()` — silently skipped timestamp resolution instead of comparing.
  Such pairs now compare as doubles; int-vs-int still compares exactly
  (nanosecond-safe). Pinned by `test_crdt_float_timestamps`, including the
  per-element case under `MERGE_BY_KEY`.

- `plugins/beam/ecto`'s `merge_jsonb/3` returned its changeset **unchanged** —
  it never merged anything. It now fetches the stored value, merges the incoming
  change through the NIF with the configured policy, and puts the result back
  preserving the change's shape (decoded term or raw JSON text); a merge failure
  becomes a changeset error (`validation: :opto_sync_merge`) rather than an
  exception.

- 16 defects across the ORM plugins, surfaced by the new real-database
  integration suites and each verified to fail against the unfixed code:
  **lost updates under concurrency** in kysely, typeorm, prisma and gorm (8
  concurrent syncs kept as few as 1) — fixed with `FOR UPDATE` /
  `pessimistic_write` / compare-and-set with jittered backoff; a drizzle
  transformer that threw `SyntaxError` on **every read** of a synced column;
  silent missing-row no-ops that reported success; SQL-`NULL` columns crashing
  the native addon; a prisma extension attached to every model while its field
  name was fixed; and a CAS implementation that livelocked under contention.

- Portability: `test-differential` no longer hardcodes `.dylib` and honors a
  pre-set `SYNCER_LIB_PATH`.

### Added

- **WebAssembly binding** (`bindings/wasm`) — emscripten build of the core with
  a **flat-argument C shim**, so JavaScript never lays out the options struct.
  Ships committed, reproducible artifacts (146 KB wasm / 56 KB gzipped) as
  single-file and split-wasm ES modules. 35 tests, including a 5000-iteration
  no-leak loop. This is what makes the browser use case real rather than
  aspirational.

- **BEAM binding** (`bindings/beam`) — a Rustler NIF over `syncer-rs`, so the C
  core is statically compiled and there is no shared library to install.
  `merge/3` runs on a **dirty CPU scheduler** because merging is unbounded,
  non-yieldable CPU work. Inputs are decoded as raw binaries rather than
  `String`, so non-UTF-8 input returns `{:error, :merge_failed}` instead of
  raising. Override callbacks are deliberately unexposed, matching Go. 35 tests
  + 4 doctests. All five runtimes are now implemented.

- **`core/test/fuzz/`** — four libFuzzer harnesses (`fuzz_merge`,
  `fuzz_strategies`, `fuzz_callback`, `fuzz_idempotent`) in ASan+UBSan and
  ASan+LSan variants, a JSON dictionary, and deterministically generated seed
  corpora. Campaign at release: 4.19M execs at ~135k exec/s, no crashes; Linux
  LeakSanitizer clean on both suites — macOS ASan has no LSan, so leaks had
  never been checked at all.

- **`test-differential/`** — cross-language differential harness: 305 seeded
  document pairs merged through C, TypeScript, Dart, Rust and Go with identical
  options must be **byte-identical**, plus a per-language and cross-language
  idempotency pass. It immediately caught, and now guards against, builds
  running a stale compiled core (neither the node-gyp artifact nor Go's build
  cache tracks the core C sources; `run_all.sh` force-rebuilds both).

- Concurrency suites per binding: Go 100×100-goroutine `-race` suite plus a
  1000-element benchmark; Rust 16-thread determinism and legacy/`ex`-path
  isolation; TypeScript `worker_threads` suite plus a nested-callback
  reentrancy check. All race-clean.

- Real integration coverage for the ORM plugins: all four TypeScript adapters
  against a real Postgres and the real ORM packages (61 cases / 204 assertions
  at release), and GORM (19 tests). `plugins/beam/ecto` gains 22 hermetic
  changeset tests + 3 doctests and 4 Postgres integration tests tagged
  `:integration`.

- New core edge tests: float timestamps (including per-element under
  `MERGE_BY_KEY`), int64 extremes and negatives, unicode and escaped keys, and
  the three `UNION` structural-dedup cases. The unit suite grew from 15 → 37 →
  40 across these commits and stands at **44** today.

- `core/test/stress_test.c` — a manual performance harness, not wired into
  `make` (10k-element `MERGE_BY_KEY` ≈0.38 s, 5 MB document ≈1.4 s, 100-element
  merge ≈42 µs on an M4 Max).

- GitHub Actions CI across the repo — core + sanitize, all five bindings,
  plugins, and the differential harness — with caching deliberately arranged so
  a stale compiled core can never be validated.

- Documentation: `README.md` (the repo had none),
  [`docs/MERGE_SEMANTICS.md`](docs/MERGE_SEMANTICS.md) as the contract under
  test, and [`docs/COMPATIBILITY.md`](docs/COMPATIBILITY.md) covering the
  options-struct ABI rules and the stale-artifact hazard.

### Changed

- The property suite now asserts idempotency for **every** strategy that
  promises it (`REPLACE`, `UNION`, `MERGE_BY_INDEX`, `MERGE_BY_KEY`; 600 random
  pairs each). `APPEND` is excluded by contract.
- Version assertions across the test suites are now **lower bounds** rather than
  exact pins — which immediately caught a stale addon that an exact pin would
  have passed.
- `syncer.h` documents the mixed-timestamp-format caveat: epoch on one replica
  and ISO-8601 on the other compares lexicographically and is not
  chronologically meaningful. Use one format consistently per key.

---

## [0.2.0] — 2026-07-24

The release that introduced `syncer_version()`; everything before this reported
no version at all.

### Added

- **`SYNCER_ARRAY_MERGE_BY_KEY`** — reconcile objects inside arrays by identity
  key: matched pairs deep-merge with **per-element** CRDT timestamp resolution,
  unmatched incoming elements append, base-only elements are kept, and
  non-object or identity-less elements fall back to `UNION` semantics so
  repeated syncs stay idempotent.
- **`array_match_keys`** option (default `"id"`), comma-separated; the first
  listed key *present* in an incoming element is its identity, and numeric `42`
  and string `"42"` normalize to the same identity. **This field was appended to
  `syncer_merge_options_t`, which is an ABI break for the Dart and Rust struct
  mirrors** — every mirror plus two e2e servers had to be updated in lockstep.
  The episode is why [`docs/COMPATIBILITY.md`](docs/COMPATIBILITY.md) exists.
- **`syncer_version()`**.
- Randomized property tests (idempotency, valid output, corruption robustness)
  wired into `make` and `make sanitize` (ASan/UBSan).
- Documented out-of-contract inputs, found by randomized testing rather than
  assumed: objects with **duplicate keys**, and **duplicate identity values**
  within one array under `MERGE_BY_KEY`.
- Binding option surfaces: TypeScript `arrayMatchKeys`, an `ArrayStrategy` map
  and `version()` (21 tests); Dart `mergeByKey`, `arrayMatchKeys`, `tryMerge`
  (returns null on failure), `version`, and a platform-aware library-path
  resolver (29 checks); Rust `MergeByKey`, `array_match_keys`, `version()` (12
  tests); Go a full options API (8 tests).
- ORM plugins: full merge-options passthrough for drizzle/prisma/kysely/typeorm,
  a type-check `tsconfig` plus ORM stubs, and real `reconcile_jsonb` helpers
  with CRDT defaults for diesel/sqlx/seaorm.

### Fixed

- The legacy-callback thread-local is now cleared after use.
- TypeScript: override exception handling reworked for
  `NAPI_DISABLE_CPP_EXCEPTIONS`; a dead `catch` was removed.
- Go: the binding was a `package main` demo carrying an **always-on,
  field-corrupting override callback**. Rewritten as a library package `syncer`,
  with the core statically compiled via cgo shims.
- Rust plugins (diesel/sqlx/seaorm) did not compile; the stubs were replaced
  with working helpers.
- GORM plugin: corrected callback signature and real `jsonb` merge wiring.
- Prisma plugin: a missing record now raises a descriptive error instead of an
  opaque one.

### Changed

- Dart package renamed `syncer_dart` → `syncer`.
- The BEAM binding's README was corrected to state its honest status for this
  release: a design document, not an implementation.

---

## [0.1.0] — 2026-07-23

Pre-versioning. `syncer_version()` did not exist yet, so no build in this range
reports a version string; 0.1.0 is a label applied retrospectively for this
changelog.

### Added

- The C core: `yyjson`-based deep JSON merge with a Rust FFI binding.
- **Core rewrite to a heap-based iterative DFS** — no C-stack recursion, so an
  arbitrarily deep document cannot overflow the stack. Added full JSON-path
  tracking for override callbacks (e.g. `$.users[0].profile.address`),
  configurable array merge strategies, circular-reference detection via a
  visited-pair set, and the first real test suite.
- CRDT timestamp resolution: `resolve_by_timestamp` with `lww_keys` and
  `fww_keys`.
- TypeScript ORM plugins (Drizzle, Prisma, TypeORM, Kysely) on the
  zero-deserialization design; Rust ORM plugins (SeaORM, Diesel, SQLx); a Go
  GORM plugin.
- Language bindings scaffolded.

### Fixed

- `MERGE_BY_INDEX` advanced incorrectly; corrected to single-step iteration (14
  tests green at that commit, 15 by the end of the range).
- `#[derive(Clone, Copy)]` added to `ArrayMergeStrategy` in the Rust FFI.
- `visited_set_t` zero-initialized, silencing a GCC warning.
- Removed the unused `json_vals_equal`.
- Added `index.js` so the npm package resolves, plus an install script that
  triggers the node-gyp rebuild.

[0.2.1]: https://github.com/opto-sync/syncer.c/commit/5c755a8f
[0.2.0]: https://github.com/opto-sync/syncer.c/commit/6f574d0e
[0.1.0]: https://github.com/opto-sync/syncer.c/commit/01bc913e
