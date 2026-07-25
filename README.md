# syncer.c

[![CI](https://github.com/opto-sync/syncer.c/actions/workflows/ci.yml/badge.svg)](https://github.com/opto-sync/syncer.c/actions/workflows/ci.yml)

A small C library that deep-merges JSON documents with CRDT-flavored conflict
resolution — built for reconciling the same record (same primary key, same
unique index) across a client and a server, and especially for reconciling
`jsonb` columns and other non-primitive fields.

One engine, shared by every runtime. The merge rules live here and nowhere
else, so a browser, a Node server, a Dart app, a Rust service, and an Elixir
worker all resolve the same conflict the same way.

```c
#include "syncer.h"

syncer_merge_options_t opts = syncer_default_options();
opts.array_strategy       = SYNCER_ARRAY_MERGE_BY_KEY;  /* records in arrays */
opts.array_match_keys     = "id";
opts.resolve_by_timestamp = true;
opts.lww_keys             = "updatedAt,syncedAt";       /* last write wins   */
opts.fww_keys             = "createdAt";                /* first write wins  */

char* merged = syncer_merge_json_ex(stored_jsonb, incoming_jsonb, &opts);
if (!merged) { /* invalid JSON */ }
syncer_free(merged);
```

Given a stored row and an incoming payload, a stale element inside a jsonb
array is rejected while a fresh sibling in the *same* array is applied and a
new element is appended:

```jsonc
// stored                                    incoming
{"items":[{"id":"a","updatedAt":2000,…},     {"items":[{"id":"a","updatedAt":9000,"qty":42},
           {"id":"b","updatedAt":2000,…}]}               {"id":"b","updatedAt":100,"qty":7},
                                                         {"id":"c","createdAt":3000,…}]}
// merged: a.qty=42 applied, b unchanged (stale), c appended
```

## Documentation

Start at **[docs/README.md](docs/README.md)** — the index across all three repos.
The two to read first:

- **[docs/MERGE_SEMANTICS.md](docs/MERGE_SEMANTICS.md)** — the contract: object
  and array rules, all five array strategies, timestamp comparison, when
  concurrent writes converge (and when they provably don't), documented
  out-of-contract inputs.
- **[docs/COMPATIBILITY.md](docs/COMPATIBILITY.md)** — versioning, the ABI rules
  for the options struct, and the stale-artifact hazard. **Read this before
  adding an option.**

Also: [BINDINGS](docs/BINDINGS.md) · [PLUGINS](docs/PLUGINS.md) ·
[TESTING](docs/TESTING.md) · [TROUBLESHOOTING](docs/TROUBLESHOOTING.md) ·
[SECURITY](docs/SECURITY.md) · [CONTRIBUTING](CONTRIBUTING.md) ·
[CHANGELOG](CHANGELOG.md)

## Layout

```
core/           the engine (C99, vendored yyjson, no other dependencies)
bindings/       typescript (N-API) · wasm · dart (FFI) · rust · go (cgo) · beam (Rustler NIF)
plugins/        ORM adapters: drizzle · prisma · kysely · typeorm · diesel · sqlx · seaorm · gorm · ecto
test-differential/  proves all five bindings produce byte-identical output
```

Client libraries (offline queue, IndexedDB/SQLite, transport) live in
[`opto-sync-clients`](../opto-sync-clients); end-to-end suites live in
[`opto-sync-e2e`](../opto-sync-e2e).

## Bindings

| Binding | Links the core | Override callbacks | Notes |
|---|---|---|---|
| TypeScript (`@opto-sync/syncer`) | statically, via node-gyp | yes | Node/server |
| WebAssembly | statically, via emscripten | yes | browsers, workers, edge; no native toolchain needed |
| Dart | loads the shared library | yes | `dart:ffi` |
| Rust (`syncer-rs`) | statically, via `cc` | no | |
| Go | statically, via cgo | no | core compiled into the package |
| BEAM (Elixir/Erlang) | via `syncer-rs` | no | Rustler NIF, dirty CPU scheduler |

Callbacks are omitted where re-entering a managed runtime mid-merge would be a
footgun. See [COMPATIBILITY.md](docs/COMPATIBILITY.md) for which bindings mirror
the options struct (and are therefore ABI-sensitive).

## Building and testing

```sh
cd core && make            # unit suite + randomized property tests
cd core && make sanitize   # the same suites under ASan + UBSan
```

The engine is C99 with no dependencies beyond libc, so a shared library is a
two-liner:

```sh
cd core && mkdir -p build && cd build && cmake .. && make syncer
```

Deeper layers:

| Suite | Proves |
|---|---|
| `core/test/prop_test.c` | idempotency for every strategy that promises it; output always valid JSON; corrupted input never crashes |
| `core/test/fuzz/` | coverage-guided libFuzzer campaigns (ASan+UBSan, and ASan+LSan for leaks) — `core/test/fuzz/run_fuzz.sh` |
| `test-differential/` | 305 document pairs merged through C, TypeScript, Dart, Rust and Go must be **byte-identical**, plus a per-language idempotency pass |
| per-binding suites | each binding's own option surface, plus concurrency (`-race`, threads, worker_threads) |

## Design

- **Iterative, never recursive.** Merging is a DFS over an explicit heap stack,
  so a pathologically deep document cannot overflow the C stack (tested to 1000
  levels). Structural comparison is iterative for the same reason.
- **Zero-deserialization.** Merges operate on the raw JSON text the database
  driver already has, so a host language deserializes once, at the end, instead
  of encoding and decoding around every merge.
- **Allocation failure is not a crash.** Growable buffers carry an `oom` flag;
  the merge aborts and returns `NULL` rather than emitting a partial document.
- **`NULL` means failure, never empty.** Every binding surfaces it as
  `null`/`None`/`{:error, _}`/an exception, so an unparseable input can never be
  mistaken for a successful empty merge. (Two documented compat shims aside —
  see [MERGE_SEMANTICS.md](docs/MERGE_SEMANTICS.md).)

## Status

Core is **0.2.1** (`syncer_version()`). The BEAM binding and all ORM plugins are
implemented and tested. Known limitations are enumerated in
[COMPATIBILITY.md](docs/COMPATIBILITY.md) — most importantly, integers beyond
2^53 are rounded by any JavaScript host, so high-precision timestamps belong in
digit strings.
