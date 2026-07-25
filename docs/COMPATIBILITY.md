# Compatibility and versioning

## Reporting the version

`syncer_version()` returns the core version as `"major.minor.patch"`. Every
binding surfaces it (`version()`, `nativeVersion`, `Syncer.version/0`), so a
consumer can verify at load time that the shared library it found matches the
API it was compiled against. The e2e servers report it on `/health`.

## The options struct is an ABI contract

`syncer_merge_options_t` is **mirrored field-for-field** by the bindings that
build it directly:

| Binding | How it passes options | ABI-sensitive |
|---|---|---|
| Dart (`dart:ffi`) | `SyncerMergeOptionsC` struct mirror | **yes** |
| Rust (`syncer-rs`) | `#[repr(C)]` struct mirror | **yes** |
| Go (cgo) | `C.syncer_default_options()` then field sets | no |
| TypeScript (N-API) | C++ builds the struct from `syncer_default_options()` | no |
| WebAssembly | flat-argument C shim; JS never lays out the struct | no |
| BEAM (Rustler) | via `syncer-rs` | inherits Rust's |

Adding a field to that struct is therefore **a breaking change for the Dart and
Rust bindings**, and the failure mode is silent: a mirror that is one field
short leaves the core reading uninitialized memory past the end of the
allocation, which usually "works" until it doesn't. This has already happened
once — `array_match_keys` was added in 0.2.0 and every mirror plus two e2e
servers needed updating in lockstep.

### Rules for changing options

1. **Append only.** Never reorder or remove fields; append at the end.
2. Bump the **minor** version and update `syncer_version()`.
3. Update every mirror in the same change: `bindings/dart/lib/syncer.dart`,
   `bindings/rust/src/lib.rs`, and any consumer that constructs the struct
   directly (the e2e `rust-mash` and `rust-fullstack` servers do).
4. Initialize the new field on **every** path. Prefer starting from
   `syncer_default_options()` so a missed field is a default, not garbage.
5. Expose the option through every binding and client, then re-run
   [`test-differential/`](../test-differential/) — it fails unless all five
   bindings produce byte-identical output.

Prefer the flat-argument shim pattern (as the WebAssembly binding uses) for new
bindings: passing scalars across the boundary makes struct layout a non-issue.

## Stale-artifact hazard

Two toolchains do **not** track the core's C sources as dependencies:

- **node-gyp** — `bindings/typescript/build/Release/syncer.node` is not
  rebuilt when `core/src/*.c` changes.
- **Go's build cache** — `syncer_core.c` `#include`s the core sources from
  outside the package directory, which the cache does not fingerprint.

So TypeScript and Go can silently run an **outdated merge engine** while every
test passes. This was caught for real: a differential run showed TS and Go
disagreeing with C/Dart/Rust purely because their embedded core was older.

Mitigations in place: `test-differential/run_all.sh` force-rebuilds the addon
when it is older than the core sources and builds Go with `-a`; CI never caches
`node_modules`, `build/`, `target/`, and passes `-count=1` with Go caching
disabled. **Do not add a compiled-output cache to CI.**

## Platform notes

- The shared library is `libsyncer.dylib` (macOS), `libsyncer.so` (Linux),
  `syncer.dll` (Windows). Scripts must derive this rather than hardcode it, and
  must honor a pre-set `SYNCER_LIB_PATH`.
- TypeScript, Rust, Go, and WebAssembly bindings compile the core **statically**
  and need no shared library at runtime. Only Dart FFI loads one.
- The core is C99 with no dependencies beyond libc and the vendored `yyjson`.

## Semantic-versioning policy

- **Patch** — bug fixes that do not change documented merge results. The
  UNION structural-dedup fix was an exception justified as a bug fix: the old
  behavior (key-order-dependent dedup) was never a usable contract.
- **Minor** — new options, new strategies, new bindings; existing calls keep
  their results. Note this may still be an ABI break for struct mirrors (above).
- **Major** — any change to documented merge semantics for existing options.

Merge semantics are specified in [`MERGE_SEMANTICS.md`](./MERGE_SEMANTICS.md);
treat that document as the contract under test, and change it in the same
commit as any behavior change.

## Known limitations (not bugs)

- Integers past 2^53 are rounded by any JavaScript host (browser, Express, a
  Node test harness). Rust and Dart are exact. Use digit strings for
  sub-millisecond timestamps — the core compares them numerically.
- Postgres `jsonb` renormalizes object key order and drops duplicate keys, so
  merge output is only ever **semantically** stable across a jsonb round trip,
  never byte-stable. Compare parsed values, not text.
- Duplicate keys in one object, and duplicate identity values in one array
  under `MERGE_BY_KEY`, are explicitly out of contract.
- Override callbacks are unsupported in the Rust, Go, and BEAM bindings by
  design (re-entering a managed runtime mid-merge).
- **Interior NUL bytes in an input string behave inconsistently per binding.**
  Rust and BEAM reject such input; TypeScript, WebAssembly, Dart, and Go pass a
  C string and therefore silently truncate at the NUL, so
  `{"a":1}\0 junk` merges as `{"a":1}`. JSON is text and a NUL byte in a
  document is already malformed, so this is unlikely in practice — but it is
  unverified by tests in the truncating four, and callers handling untrusted
  bytes should validate before merging. (An *escaped* `\u0000` inside a JSON
  string is different and fully supported; see the regression test
  `test_nul_in_key_not_truncated`.)
