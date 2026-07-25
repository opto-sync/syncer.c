# Bindings

Six bindings expose the same engine. The merge rules are **not** restated here —
they live in [`MERGE_SEMANTICS.md`](./MERGE_SEMANTICS.md), and the ABI rules and
stale-artifact hazards live in [`COMPATIBILITY.md`](./COMPATIBILITY.md). This
document is about getting each binding built, called correctly, and failing
loudly.

Core version at the time of writing: **0.2.1** (`syncer_version()`), confirmed
through the TypeScript, WebAssembly, Dart, Rust, and Go bindings.

Nothing is published to npm / crates.io / pub.dev / Hex yet. Every consumer in
this repository depends on a binding by **path** (`file:` in npm, `path =` in
Cargo, `path:` in pubspec/mix, a `replace` directive in Go).

## At a glance

| Binding | Package / crate / app name | Links the core | Override callbacks | Init model |
|---|---|---|---|---|
| `bindings/typescript` (N-API) | `@opto-sync/syncer` | static, node-gyp compiles `core/src/*.c` into `syncer.node` | **yes** (`overrideCb`, or positional) | `require()`; addon loaded at first import |
| `bindings/wasm` (emscripten) | `@opto-sync/syncer-wasm` (+ `/split`) | static, into the `.wasm` | **yes** (`overrideCb`) | **`await initSyncer()`** before any call |
| `bindings/dart` (`dart:ffi`) | pubspec name `syncer` | **dynamic** — `DynamicLibrary.open` | **yes** (`overrideCb`, C function pointer) | `Syncer(libPath)` constructor |
| `bindings/rust` | crate `syncer-rs` | static, via `cc` in `build.rs` | no (safe API); raw `extern "C"` items are public | free functions, no init |
| `bindings/go` (cgo) | module `github.com/opto-sync/syncer-go` | static, `syncer_core.c` `#include`s the core | no | package functions, no init |
| `bindings/beam` (Rustler NIF) | Mix app `:opto_sync_nif`, module `Syncer` | static, via `syncer-rs` | no | NIF loaded on app start |

Only the Dart binding needs a shared library at runtime (verified: `binding.gyp`
compiles the core sources; `bindings/rust/build.rs` uses `cc`;
`bindings/go/syncer_core.c` + `yyjson_core.c` `#include` the core into the cgo
package; `bindings/wasm/build.sh` compiles the core into the wasm; the BEAM NIF
inherits Rust's static link).

## Option names per binding

Same seven options everywhere, spelled per language convention. The core field
name is in the first column so you can cross-reference
`core/include/syncer.h`.

| `syncer_merge_options_t` | TypeScript / wasm | Dart | Rust (`MergeOptions`) | Go (`Options`) | BEAM (keyword) |
|---|---|---|---|---|---|
| `array_strategy` | `arrayStrategy` | `arrayStrategy` | `array_strategy` | `ArrayStrategy` | `:array_strategy` |
| `array_match_keys` | `arrayMatchKeys` | `arrayMatchKeys` | `array_match_keys` | `ArrayMatchKeys` | `:array_match_keys` |
| `max_depth` | `maxDepth` | `maxDepth` | `max_depth` | `MaxDepth` | `:max_depth` |
| `detect_circular_refs` | `detectCircularRefs` | `detectCircularRefs` | `detect_circular_refs` | `DetectCircularRefs` | `:detect_circular_refs` |
| `resolve_by_timestamp` | `resolveByTimestamp` | `resolveByTimestamp` | `resolve_by_timestamp` | `ResolveByTimestamp` | `:resolve_by_timestamp` |
| `lww_keys` | `lwwKeys` | `lwwKeys` | `lww_keys` | `LwwKeys` | `:lww_keys` |
| `fww_keys` | `fwwKeys` | `fwwKeys` | `fww_keys` | `FwwKeys` | `:fww_keys` |
| `override_cb` | `overrideCb` | `overrideCb` | — | — | — |

Strategy constants:

| Strategy | TypeScript / wasm | Dart | Rust | Go | BEAM |
|---|---|---|---|---|---|
| 0 | `ArrayStrategy.REPLACE` | `ArrayMergeStrategy.replace` | `ArrayMergeStrategy::Replace` | `syncer.ArrayReplace` | `:replace` |
| 1 | `.APPEND` | `.append` | `::Append` | `syncer.ArrayAppend` | `:append` |
| 2 | `.UNION` | `.union` | `::Union` | `syncer.ArrayUnion` | `:union` |
| 3 | `.MERGE_BY_INDEX` | `.mergeByIndex` | `::MergeByIndex` | `syncer.ArrayMergeByIndex` | `:merge_by_index` |
| 4 | `.MERGE_BY_KEY` | `.mergeByKey` | `::MergeByKey` | `syncer.ArrayMergeByKey` | `:merge_by_key` |

### An unset key list is not an empty key list

`core/src/syncer.c` (lines 643–645) resolves a **NULL** pointer to a default:

```c
const char* lww_keys   = (opts && opts->lww_keys)         ? opts->lww_keys         : "updatedAt";
const char* fww_keys   = (opts && opts->fww_keys)         ? opts->fww_keys         : NULL;
const char* match_keys = (opts && opts->array_match_keys) ? opts->array_match_keys : "id";
```

So with `resolveByTimestamp` on and **no** LWW keys configured, the core still
applies Last-Write-Wins on `updatedAt`. This is easy to trip over because every
binding maps "absent" to NULL:

| Binding | "absent" spelling that becomes NULL |
|---|---|
| TypeScript / wasm | the property is missing, or not a string (`undefined`) |
| Dart | `null` |
| Rust | `None` |
| Go | `""` (the empty string — the field is only set when non-empty) |
| BEAM | omitted, `nil`, `""`, or `[]` (all normalized to `nil`) |

Verified against Go, whose doc comment says "Empty = none":

```go
syncer.MergeJSONWithOptions(`{"updatedAt":100,"v":"base"}`,
                            `{"updatedAt":50,"v":"incoming"}`,
                            syncer.Options{ResolveByTimestamp: true})
// -> {"updatedAt":100,"v":"base"}   ← LWW applied on updatedAt anyway
```

Pass an explicit `""` if you truly want "no keys": TypeScript, wasm, Dart and
Rust distinguish it from absent (empty string → pointer to `""`); **Go and the
BEAM binding do not** — both collapse `""` to NULL, so under those two bindings
the `updatedAt` default cannot be switched off while `resolve_by_timestamp` is
enabled. (Gap, stated rather than papered over.)

## How merge failure surfaces

The core returns `NULL` when either input is not valid JSON. Failure is
**never** an empty string in the recommended API of any binding:

| Binding | Recommended API | Failure value | Legacy/compat API that returns `""` |
|---|---|---|---|
| TypeScript | `mergeJson()` | `null` | — |
| wasm | `mergeJson()` | `null` | — |
| Dart | `tryMerge()` | `null` | **`merge()` returns `''`** |
| Rust | `try_merge_json_with_options()` | `None` | **`merge_json()` / `merge_json_with_options()` return `""`** |
| Go | `MergeJSONWithOptions()` | `("", ErrMergeFailed)` | — |
| BEAM | `Syncer.merge/3` | `{:error, :merge_failed}` | — (`merge!/3` raises `Syncer.MergeError`) |

Two deliberate exceptions exist and are named above: `Syncer.merge` in Dart and
`merge_json*` in Rust are backwards-compatibility shims that collapse failure to
`""`. Both are documented as such in their source and both have tests asserting
the `""` behavior (`bindings/dart/bin/test.dart`,
`bindings/rust/src/lib.rs::test_invalid_json_is_none`). Do not use them in new
code; `MERGE_SEMANTICS.md`'s "never an empty string" guarantee applies to the
`try*` forms.

The BEAM NIF takes binaries, not `String`, so non-UTF-8 input is
`{:error, :merge_failed}` rather than an `ArgumentError` from the decoder.

### Interior NUL bytes are handled inconsistently — measured

A `\0` inside an input string cannot cross a C string boundary. Two behaviors
exist, and the difference is observable:

| Binding | `'{"a":1}' + "\0" + ' junk'` merged with `{"b":2}` | `{"b":"x\0y"}` as incoming |
|---|---|---|
| Rust, BEAM | rejected — `None` / `{:error, :merge_failed}` (`CString::new` fails) | rejected |
| TypeScript, wasm, Dart, Go | **silently truncated at the NUL** → `{"a":1,"b":2}` | `null` / `ErrMergeFailed` (the truncated text is invalid JSON) |

So on the four truncating bindings, content after a NUL in an otherwise-valid
document is dropped without any error. Do not feed unsanitized binary blobs to
those bindings and assume a NUL will be reported. (`bindings/rust`'s
`test_interior_nul_does_not_panic` pins the Rust behavior; the truncation
behavior of the other four is measured here, not covered by any test.)

---

## TypeScript (N-API) — `bindings/typescript`

### Build and test

```sh
cd syncer.c/bindings/typescript
npm install          # runs `node-gyp rebuild` via the install script
npm test             # == node test.js
node test-concurrency.js
```

Ran here: `node test.js` → 21 checks, "All binding tests passed";
`node test-concurrency.js` → 2 checks pass in 21 ms (8 worker_threads × 200
merges byte-identical to the single-threaded result, plus a reentrancy check);
`npm test` identical to `node test.js`. `version()` → `0.2.1`.

Requires a C/C++ toolchain and Node with node-gyp (Node 22 used here). The addon
lands at `build/Release/syncer.node`; `index.js` tries `./build/Release/…` first,
then `../build/Release/…`, and throws
`Native syncer module not found. Did you compile it with node-gyp?` if neither
loads.

### API

`index.js` (CommonJS) / `index.ts` (source) / `index.d.ts` (types) export
exactly three things: `mergeJson`, `version`, `ArrayStrategy`. `index.js` also
sets `module.exports.default` for interop.

```js
const { mergeJson, version, ArrayStrategy } = require('@opto-sync/syncer');

version(); // "0.2.1"

mergeJson(
  '{"items":[{"id":"a","updatedAt":2000,"qty":1}]}',
  '{"items":[{"id":"a","updatedAt":9000,"qty":42},{"id":"b","createdAt":3000}]}',
  {
    arrayStrategy: ArrayStrategy.MERGE_BY_KEY,
    arrayMatchKeys: 'id',
    resolveByTimestamp: true,
    lwwKeys: 'updatedAt,syncedAt',
    fwwKeys: 'createdAt',
  },
);
// '{"items":[{"id":"a","updatedAt":9000,"qty":42},{"id":"b","createdAt":3000}]}'

mergeJson('{oops', '{}'); // null
```

Both arguments must be strings; anything else throws `TypeError: String
expected` from `src/addon.cc`. A function may be passed positionally as the
third argument (legacy form) instead of an options object — the addon tests
`IsFunction` before `IsObject` precisely because a function is also an object.

`bindings/typescript/BaseMergeStrategy.ts` is an optional helper: subclass
`BaseMergeStrategy<T>`, implement `handleConflict(key, parsedV1, parsedV2)`, and
pass `strategy.toNativeCallback()` as `overrideCb`. The adapter parses both
sides, reduces the JSON path to its last segment (`lastPathSegment`), and
stringifies your return value. Binding `handleConflict` directly as `overrideCb`
never matches, because the native callback receives `$.a.b.c`, not `c`.

### Callbacks and memory

Supported. Signature `(jsonPath, v1Json, v2Json) => string | undefined | null`.
Return a JSON string to substitute, `undefined`/`null` to decline. **You do not
manage memory**: `addon.cc` `strdup`s your string and the core `free()`s it.

Exception semantics (asserted by `test.js`): a throw from the callback is left
pending on the env, the callback is not invoked again for the rest of that
merge (the core falls back to its default merge), the merge result is discarded,
and the exception propagates to the `mergeJson()` caller.

Thread safety: the callback slot is `thread_local`, saved and restored around
each call, so `worker_threads` and a callback that re-enters `mergeJson` are both
safe. `test-concurrency.js` pins both.

### Gotchas

- **Stale artifact.** node-gyp does not track `core/src/*.c`, so
  `build/Release/syncer.node` can keep running an old engine while every test
  passes. Rebuild with `npm run build` after touching the core.
  `test-differential/run_all.sh` force-rebuilds when the addon is older than the
  core sources; CI never caches `build/`. See `COMPATIBILITY.md`.
- `package.json` says `"version": "0.2.0"` while the addon reports the core's
  `0.2.1`. Trust `version()`, not the package version.
- The addon only reads an option when its JS type matches (`IsNumber`,
  `IsBoolean`, `IsString`), so `arrayStrategy: '4'` is silently ignored.

---

## WebAssembly — `bindings/wasm`

### Build and test

```sh
cd syncer.c/bindings/wasm
npm test          # node --test test/wasm.test.mjs — no install step, no deps
./build.sh        # regenerate dist/ (needs Docker; emscripten/emsdk:6.0.4 pinned)
```

Ran here: `npm test` → **35/35 pass** in ~0.43 s against the committed `dist/`.
`version()` → `0.2.1`.

`dist/` is committed on purpose so browser consumers never need emscripten.

### API

Two entry points, same surface: `@opto-sync/syncer-wasm` (wasm inlined,
zero-config) and `@opto-sync/syncer-wasm/split` (separate `.wasm`, also exports
`wasmUrl`). Exports: `initSyncer`, `isReady`, `mergeJson`, `version`,
`ArrayStrategy`, `heapAllocatedBytes`, `heapTotalBytes`, plus a default export
carrying all of them.

```js
import { initSyncer, mergeJson, version, ArrayStrategy } from '@opto-sync/syncer-wasm';

await initSyncer();          // idempotent, concurrency-safe
version();                   // "0.2.1"

mergeJson(localJson, serverJson, {
  arrayStrategy: ArrayStrategy.MERGE_BY_KEY,
  arrayMatchKeys: 'id',
  resolveByTimestamp: true,
  lwwKeys: 'updatedAt,syncedAt',
  fwwKeys: 'createdAt',
});
```

Option names are identical to the Node binding's, so a shared reconcile module
types against either (`MergeOptions` in both `index.d.ts` files is structurally
the same).

Split build outside a browser (there is nothing to `fetch()`):

```js
import { initSyncer, mergeJson, wasmUrl } from '@opto-sync/syncer-wasm/split';
import { readFile } from 'node:fs/promises';
await initSyncer({ wasmBinary: await readFile(wasmUrl) });
```

Both forms were run here; the split build produced the same output as the
single-file build.

### Init model — the one real difference from Node

`initSyncer(options?)` returns a `Promise` and **must resolve before**
`mergeJson()` or `version()`. Calling too early throws:

```
opto-sync wasm: engine not initialized. Call `await initSyncer()` before mergeJson()/version().
```

(Verified.) It is idempotent and shares one in-flight instantiation across
concurrent callers; a rejected init is not cached, so a retry is possible.
`isReady()` reports the state without throwing.

### Callbacks and memory

Supported, including JS re-entry from wasm. Your returned string is copied into
the wasm heap and **ownership transfers to the core**, which frees it. Everything
the wrapper itself allocates is released in a `finally` block, and the
function-table slot taken by `addFunction` is released with `removeFunction`
(otherwise the table grows by one slot per merge). A throw from your callback is
remembered, suppresses further callback invocations, and is rethrown after the C
frames unwind — the same shape as the Node binding.

`heapAllocatedBytes()` exposes dlmalloc's `uordblks`; the suite runs 5,000
merges and asserts it is *exactly* unchanged.

### Gotchas

- **`undefined` ≠ `''`** for `lwwKeys` / `fwwKeys` / `arrayMatchKeys` (see the
  key-list section above). Do not normalize options with `x || ''`.
- CSP: instantiating wasm needs `script-src 'wasm-unsafe-eval'`.
- The glue is generated with `-sENVIRONMENT=web,worker` and a test asserts it
  contains no Node builtins — so it is browser-loadable, but the split build
  cannot self-load in Node (hence `wasmBinary`).
- `syncer_merge_json_ex` is deliberately **not** exported; JS can only reach the
  flat-argument shim in `src/syncer_wasm.c`, which builds the options struct in C
  from `syncer_default_options()`. This is the pattern `COMPATIBILITY.md`
  recommends for new bindings.
- The README's size table (146,003 B `.wasm`) is stale against the current
  `dist/` (147,213 B `.wasm`, 179,510 B single-file). Sizes only; behavior is
  current (`0.2.1`).

---

## Dart FFI — `bindings/dart`

### Build and test

The core must exist as a **shared library** first:

```sh
cd syncer.c/core && mkdir -p build && cd build && cmake .. && make syncer
# -> core/build/libsyncer.dylib | libsyncer.so | syncer.dll

cd syncer.c/bindings/dart
dart pub get
dart bin/test.dart
```

Ran here: `cmake .. && make syncer` → `libsyncer.dylib`; `dart pub get` → ok;
`dart bin/test.dart` → 28 checks, "All Dart binding checks passed"
(`version` → `0.2.1`).

### API

```dart
import 'package:syncer/syncer.dart';

final syncer = Syncer(resolveSyncerLibraryPath(directory: '../../core/build'));
print(syncer.version); // 0.2.1

final merged = syncer.tryMerge(
  '{"items":[{"id":"a","updatedAt":2000,"qty":1}]}',
  '{"items":[{"id":"a","updatedAt":9000,"qty":42},{"id":"b","createdAt":3000}]}',
  options: MergeOptions(
    arrayStrategy: ArrayMergeStrategy.mergeByKey,
    arrayMatchKeys: 'id',
    resolveByTimestamp: true,
    lwwKeys: 'updatedAt,syncedAt',
    fwwKeys: 'createdAt',
  ),
);
if (merged == null) { /* invalid JSON */ }
```

(Run verbatim here; output
`{"items":[{"id":"a","updatedAt":9000,"qty":42},{"id":"b","createdAt":3000}]}`,
and `tryMerge('{oops', '{}')` → `null`.)

Surface: `Syncer(String libPath)` with `version`, `tryMerge`, `merge`;
`MergeOptions`; `ArrayMergeStrategy` (alias `ArrayStrategy`);
`resolveSyncerLibraryPath({String directory = '.'})`; the FFI typedefs
`MergeOverrideCbC` / `MergeOverrideCbDart`; the struct mirror
`SyncerMergeOptionsC`; and `syncerLibPathEnvVar`.

### Runtime requirement

The only binding that loads a shared library at runtime.
`resolveSyncerLibraryPath` resolves in this order:

1. `SYNCER_LIB_PATH`, if set and non-empty.
2. Inside `directory`: the platform-preferred name first
   (`libsyncer.dylib` / `libsyncer.so` / `syncer.dll`), then the other
   candidates (including `libsyncer.dll`), returning the first that exists.
3. Otherwise the platform-preferred path anyway, so `DynamicLibrary.open`
   reports the canonical missing location.

Ship the library next to your app and pass an absolute path, or set
`SYNCER_LIB_PATH`.

### Callbacks and memory

Supported, as a raw C function pointer:

```dart
Pointer<Utf8> onConflict(Pointer<Utf8> path, Pointer<Utf8> v1, Pointer<Utf8> v2) {
  if (path.toDartString() == r'$.override_me') {
    return '{"custom":"merged from Dart!"}'.toNativeUtf8(); // malloc'd; core frees it
  }
  return nullptr; // decline -> default merge for this node
}

final cb = Pointer.fromFunction<MergeOverrideCbC>(onConflict);
syncer.tryMerge(a, b, options: MergeOptions(overrideCb: cb));
```

**Ownership contract:** a non-null returned `Pointer<Utf8>` is consumed and
`free()`d by the C core. It must come from the C allocator —
`String.toNativeUtf8()` (package:ffi `malloc`) satisfies this. Never return a
cached/static pointer, a pointer you also free yourself (double free), or one
from an allocator incompatible with `free`. Return `nullptr` to decline.

Because `Pointer.fromFunction` is used, the callback must be a **top-level or
static** function — closures cannot be converted. The merge is synchronous on
the calling isolate's thread, so no `NativeCallable.listener` plumbing is needed.

### Gotchas

- **ABI-sensitive.** `SyncerMergeOptionsC` mirrors
  `syncer_merge_options_t` field-for-field and is heap-allocated and passed by
  pointer; a mirror one field short makes the core read past the allocation. Any
  new core option must be appended here in lockstep (`COMPATIBILITY.md`).
- Prefer `tryMerge` (`null` on failure). `merge` returns `''` on failure.
- `pubspec.yaml` declares `version: 0.2.0` and `publish_to: 'none'`; the runtime
  version comes from whichever `libsyncer` you loaded — check `syncer.version`
  at startup, which is exactly what `syncer_version()` exists for.

---

## Rust — `bindings/rust` (`syncer-rs`)

### Build and test

```sh
cd syncer.c/bindings/rust
cargo test
```

Ran here: **12 unit tests + 3 concurrency integration tests pass** (0 failures).
`build.rs` compiles `core/src/syncer.c` and `core/src/yyjson.c` with the `cc`
crate and has `rerun-if-changed` on both plus `syncer.h`, so unlike node-gyp and
Go's cache it does track the core sources.

Depend on it by path:

```toml
[dependencies]
syncer-rs = { path = "../../syncer.c/bindings/rust" }
```

### API

```rust
use syncer_rs::{try_merge_json_with_options, version, ArrayMergeStrategy, MergeOptions};

let opts = MergeOptions {
    array_strategy: Some(ArrayMergeStrategy::MergeByKey),
    array_match_keys: Some("id".into()),
    resolve_by_timestamp: true,
    lww_keys: Some("updatedAt,syncedAt".into()),
    fww_keys: Some("createdAt".into()),
    ..MergeOptions::default()
};

match try_merge_json_with_options(stored, incoming, &opts) {
    Some(merged) => { /* ... */ }
    None => { /* invalid JSON, or an interior NUL byte */ }
}

version(); // "0.2.1"
```

(Compiled and run here as a temporary integration test; printed
`Some("{\"items\":[{\"id\":\"a\",\"updatedAt\":9000,\"qty\":42}]}")` and
`version = 0.2.1`.)

Public surface: `version()`, `merge_json()`, `merge_json_with_options()`,
`try_merge_json_with_options()`, `MergeOptions`, `ArrayMergeStrategy`,
`MergeOverrideCbEx`, `SyncerMergeOptionsC`, and the raw `extern "C"` items
`syncer_merge_json`, `syncer_merge_json_ex`, `syncer_free`, `syncer_version`.
There is no `try_merge_json` without options — use
`try_merge_json_with_options(a, b, &MergeOptions::default())`.

`MergeOptions` is `#[derive(Default)]`, so `..MergeOptions::default()` gives
`Replace`, unlimited depth, no timestamp resolution, and `None` key lists.

### Callbacks

Not exposed by the safe API: `MergeOptions` has no override field and
`try_merge_json_with_options` always sets `override_cb: None`. The `#[repr(C)]`
mirror `SyncerMergeOptionsC` *does* have a public `override_cb`, and the
`extern "C"` functions are public, so a caller can wire a callback by hand — that
is unsafe FFI you own, not a supported API, and there are no tests for it.

### Gotchas

- **ABI-sensitive.** `SyncerMergeOptionsC` is the second field-for-field mirror
  (with Dart). `array_match_keys` must remain last; appending a core field means
  editing this struct in the same change.
- Failure is `None` only via `try_merge_json_with_options`. `merge_json` and
  `merge_json_with_options` return `""` (compat).
- Strict UTF-8 on the way out: a non-UTF-8 result is reported as `None` rather
  than lossily converted. (Unreachable in practice — JSON is UTF-8.)
- The crate version is `0.2.0` in `Cargo.toml` while the linked core is `0.2.1`;
  `version()` is the source of truth, and `tests::test_version` asserts
  `>= "0.2.0"`.
- `tests/concurrency.rs` covers the extended path from many threads *and* the
  legacy `syncer_merge_json` entry point (the only place the core uses a
  `__thread` slot), asserting they do not interfere.

---

## Go (cgo) — `bindings/go`

### Build and test

```sh
cd syncer.c/bindings/go
go test ./...
go test -race -count=1 ./...     # what CI runs
```

Ran here: `go test ./...` → `ok github.com/opto-sync/syncer-go`;
`go test -race -count=1 ./...` → `ok` (1.6 s). Needs cgo and a C compiler; no
shared library, no `LD_LIBRARY_PATH`.

Consume it with a `replace`, as the GORM plugin and the differential runner do:

```
require github.com/opto-sync/syncer-go v0.0.0
replace github.com/opto-sync/syncer-go => ../../syncer.c/bindings/go
```

### API

```go
import syncer "github.com/opto-sync/syncer-go"

opts := syncer.Options{
    ArrayStrategy:      syncer.ArrayMergeByKey,
    ArrayMatchKeys:     "id",
    ResolveByTimestamp: true,
    LwwKeys:            "updatedAt,syncedAt",
    FwwKeys:            "createdAt",
}

merged, err := syncer.MergeJSONWithOptions(stored, incoming, opts)
if errors.Is(err, syncer.ErrMergeFailed) { /* invalid JSON */ }

syncer.Version() // "0.2.1"
```

(Run verbatim here against a temporary module: output
`0.2.1 {"items":[{"id":"a","updatedAt":9000,"qty":42},{"id":"b","createdAt":3000}]}`,
and `MergeJSON("{oops", "{}")` returned `ErrMergeFailed`.)

Surface: `Version()`, `MergeJSON(base, incoming)`,
`MergeJSONWithOptions(base, incoming, Options)`, `ErrMergeFailed`, the
`Options` struct, and the `ArrayStrategy` constants. The zero `Options` value
equals `syncer_default_options()`; the binding starts from
`C.syncer_default_options()` and then sets fields, so it is not ABI-sensitive.

`cmd/demo/main.go` is a runnable example (`go run ./cmd/demo`).

### Callbacks

Not exposed, deliberately (see the package doc comment): bridging per-key Go
callbacks needs a registry plus `cgo.Handle` and costs far more than the merge.

### Gotchas

- **Stale artifact.** `syncer_core.c` / `yyjson_core.c` `#include` the core from
  *outside* the package directory, which Go's build cache does not fingerprint.
  A cached build can pass tests against an outdated engine. Mitigations:
  `go build -a` in `test-differential/run_all.sh`, `-count=1` and
  `cache: false` in CI. Do not add a build cache.
- `LwwKeys: ""` does **not** mean "no LWW keys" — see the key-list section. The
  doc comment on the field ("Empty = none") is wrong; measured behavior is the
  core default `updatedAt`.
- `Options.ArrayStrategy` is passed through unvalidated; an out-of-range value
  reaches the C enum.
- `C.CString` truncates at an interior NUL byte, so a document containing one is
  silently shortened rather than rejected (see the failure section).
- Struct-level thread safety: the `syncer_merge_json_ex` path is stateless, and
  `concurrency_test.go` runs 100 goroutines × 100 merges under `-race` asserting
  byte-identical output.

---

## BEAM (Elixir / Erlang / Gleam) — `bindings/beam`

Mix app `:opto_sync_nif`, public module `Syncer`, Rustler NIF crate
`native/syncer_nif` with a path dependency on `syncer-rs` (which statically
compiles the C core). No shared library to install.

### Build and test

`elixir`/`mix` are not assumed to be present locally — and were **not** present
on the machine where this document was written, so **the BEAM suite was not
run here.** It is exercised through the Docker image described in
`bindings/beam/README.md` / `bindings/beam/Dockerfile.test`:

```sh
cd syncer.c/bindings/beam
docker build -f Dockerfile.test -t opto-sync-beam-test .

# from syncer.c/
docker run --rm -v "$PWD":/src -w /src/bindings/beam opto-sync-beam-test \
  sh -c 'mix deps.get && mix test'
```

The image is `rust:1.97-slim` plus `build-essential`, `elixir` and
`erlang-dev` from Debian trixie (Elixir 1.18 / OTP 27), because the official
Elixir images have no cargo — three toolchains are needed at once (Rust for the
NIF, a C compiler for the core, Elixir/OTP). Build requirements when running
natively: Rust ≥ 1.70, `cc`, Elixir ≥ 1.14 / OTP ≥ 25. `mix compile` builds the
crate in release mode and copies `syncer_nif.so` into `priv/native/`.

Static counts (read, not run): `test/syncer_test.exs` contains **35 tests**, and
`lib/syncer.ex` contains **4 doctests** — matching the README's "35 tests + 4
doctests". One of those doctests asserts `Syncer.version() == "0.2.0"`, which
**cannot pass against core 0.2.1**; see the drift list at the end of this
document.

### API

```elixir
Syncer.merge(base_json, incoming_json, opts \\ [])   # {:ok, json} | {:error, :merge_failed}
Syncer.merge!(base_json, incoming_json, opts \\ [])  # json, raises Syncer.MergeError
Syncer.crdt_options(overrides \\ [])                 # the project-wide policy, as a keyword list
Syncer.normalize_options(opts)                       # validated option map (used by the Ecto plugin)
Syncer.version()                                     # "major.minor.patch"
```

```elixir
{:ok, merged} =
  Syncer.merge(
    ~s({"items":[{"id":1,"updatedAt":2000,"qty":1}]}),
    ~s({"items":[{"id":1,"updatedAt":9000,"qty":42}]}),
    Syncer.crdt_options()
  )

Syncer.merge("{oops", "{}")
#=> {:error, :merge_failed}
```

`Syncer.crdt_options/1` expands to
`[array_strategy: :merge_by_key, array_match_keys: "id", resolve_by_timestamp: true, lww_keys: "updatedAt,syncedAt", fww_keys: "createdAt"]`,
with `overrides` merged on top.

Both sides are **JSON text** (binaries), never decoded terms — the point of the
native engine is to avoid a round trip through Elixir maps. Encode first
(`Jason.encode!/1`) or use the Ecto plugin, which does it for you.

Key-list options accept a comma-separated binary **or** a list of binaries/atoms
(`[:updatedAt, :syncedAt]`), joined for you. Erlang and Gleam callers can use
`'Elixir.Syncer':merge(Base, Incoming, [])` — the options are a plain proplist.

Bad **options** are a programming error and raise `ArgumentError` (unknown key,
unknown strategy, non-boolean flag, out-of-range `:max_depth`). Bad **data** is
`{:error, :merge_failed}`.

### Callbacks

Not exposed, deliberately. A NIF cannot call an Elixir function; bridging the
hook would mean messaging a BEAM process from native code and blocking a dirty
scheduler thread on the reply, with no timeout story and a deadlock if the
callback process is itself merging. Express custom resolution through
`:lww_keys` / `:fww_keys` / `:array_match_keys`, or split the document.

### Gotchas

- **Dirty CPU scheduler.** `merge/3` is `#[rustler::nif(schedule = "DirtyCpu")]`.
  A merge is unbounded CPU work (and `:merge_by_key` is quadratic in array
  length in the worst case) with no way to yield, so it must not sit on a normal
  scheduler thread. Consequence: dirty CPU schedulers are a finite pool
  (`+SDcpu`, default = number of normal schedulers), so heavy merge concurrency
  queues *there* instead of degrading the rest of the VM. `version/0` is a
  constant lookup and stays on a normal scheduler.
- Rust is the safety boundary: a panic in native code becomes an exception in
  the calling process rather than taking down the VM.
- Options are validated in Elixir and handed to the NIF as a **total map**
  (`Syncer.normalize_options/1`), so the Rust `NifMap` decode cannot fail on
  user input. If you call `Syncer.Native.merge/3` directly you must pass that
  map; it is not public API.
- ABI exposure is inherited from `syncer-rs` (its `#[repr(C)]` mirror), not
  re-declared here.
- `priv/native/syncer_nif.so` is a build artifact (git-ignored). The copy
  present on this machine embeds the string `0.2.0`, i.e. it predates the core's
  0.2.1 bump — a reminder to rebuild before trusting a checked-out `.so`.
  `syncer-rs`'s `build.rs` does track the core sources, so `mix compile` after a
  core change rebuilds it.

---

## Cross-binding guarantees

- `test-differential/` merges 305 document pairs through C, TypeScript, Dart,
  Rust and Go and requires **byte-identical** output, plus a per-language
  idempotency pass. `./run_all.sh` builds every runner first, force-rebuilding
  the Node addon when it is older than the core sources and building Go with
  `-a`. The wasm and BEAM bindings are not in that harness; wasm parity with the
  Node addon is asserted from
  `opto-sync-clients/clients/ts/test/engine-parity.test.mjs` (not run here), and
  the BEAM binding rides on `syncer-rs`.
- Every binding surfaces `syncer_version()`; check it at load time when you load
  a shared library (Dart) or a prebuilt artifact.

## Documentation drift found while verifying (reported, not fixed)

These are inaccuracies in files this document does not own. Nothing below
affects merge behavior.

| Where | Claim | Reality |
|---|---|---|
| `bindings/beam/lib/syncer.ex` (doctest, ~line 176) | `Syncer.version()` → `"0.2.0"` | core is `0.2.1`; this doctest must fail, so "35 tests + 4 doctests green" cannot currently hold |
| `bindings/go/syncer.go` (`Options.LwwKeys` doc) | "Empty = none" | empty → NULL → core default `updatedAt` (measured) |
| `bindings/wasm/README.md` | size table, `version()` → `"0.2.0"` | `dist/` is 147,213 B / 179,510 B and reports `0.2.1` |
| `bindings/typescript/package.json`, `bindings/dart/pubspec.yaml`, `bindings/rust/Cargo.toml`, `bindings/beam/mix.exs`, `plugins/*` manifests | `0.2.0` | core is `0.2.1` (package versions are independent, but they all read as the core version) |
| `bindings/beam/README.md`, `plugins/beam/ecto/README.md`, several module docs | "the syncer.c engine (v0.2.0)" | `0.2.1` |
| `.github/workflows/ci.yml` (core job comment) | "40 unit tests" | 44 (`make` prints `44/44 passed`) |
| `plugins/typescript/test/core-contract.test.ts`, `plugins/typescript/README.md` | the override callback is not consulted for arrays under `UNION`/`MERGE_BY_KEY` | fixed in 0.2.1 — see [`PLUGINS.md`](./PLUGINS.md) |
