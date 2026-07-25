# Testing opto-sync

There are roughly a dozen suites spread across three sibling repositories. This
document is the map: what each layer proves, what it catches that nothing else
does, how to run it, and how long it takes.

The contract under test is [`MERGE_SEMANTICS.md`](./MERGE_SEMANTICS.md); the ABI
and versioning rules the harnesses defend are in
[`COMPATIBILITY.md`](./COMPATIBILITY.md).

Repository layout assumed throughout — the three repos must be siblings, because
every path dependency and every docker build context is relative:

```
opto-sync/
  syncer.c/            the core, bindings, plugins, differential harness
  opto-sync-clients/   ts / dart / rust client libraries
  opto-sync-e2e/       servers + end-to-end suites (docker)
```

---

## 1. The layer map

Timings below were measured on macOS/arm64 (M-series), warm caches unless noted.

| # | Layer | Where | Proves | Catches that nothing else does | Runtime |
|---|---|---|---|---|---|
| 1 | Core unit | `syncer.c/core/test/test_syncer.c` | Named merge behaviours: all five array strategies, LWW/FWW, callbacks, contract edges | A wrong *merge result* for a specific documented case | 4.9 s (incl. compile) |
| 2 | Core property | `syncer.c/core/test/prop_test.c` | Idempotency + valid-output + crash-freedom over thousands of generated pairs | Violations on inputs nobody thought to write down | in the same 4.9 s |
| 3 | Sanitizers | same two suites | No ASan/UBSan finding | Memory errors and UB that a passing assertion hides | 33 s |
| 4 | Fuzzing | `syncer.c/core/test/fuzz/` | Coverage-guided exploration of inputs *and* option combinations; real LeakSanitizer | Leaks (macOS has no LSan) and deep parser/strategy interactions | build ≈2 min + `DURATION` per harness |
| 5 | Differential | `syncer.c/test-differential/` | C, TypeScript, Dart, Rust, Go produce **byte-identical** output over 305 pairs, twice | One binding drifting from the others — including a *stale compiled core* | 24 s |
| 6 | Per-binding | `syncer.c/bindings/*` | Each binding's own option surface, error mapping, and thread safety | An option that never reaches the core; a race in the binding glue | 0.1–9 s each |
| 7 | ORM plugins | `syncer.c/plugins/*` | The read-merge-write path against a real database | Lost updates, missing-row no-ops, SQL-NULL crashes | s to minutes; most need Postgres |
| 8 | Client libraries | `opto-sync-clients/clients/*` | Offline queue, durability, reconcile defaults, wasm↔native parity, real browser | A client whose default policy disagrees with the server's | 2–6 s each |
| 9 | E2E conformance | `opto-sync-e2e/test/conformance/` | Scenario behaviour through real HTTP + real Postgres `jsonb` | Anything the `jsonb` round trip changes (key order, numerics, unicode) | docker |
| 10 | E2E cross-server | `opto-sync-e2e/test/cross-server/` | Four server runtimes converge on one mutation sequence | A host runtime mangling data before the core sees it | docker |
| 11 | E2E clients | `opto-sync-e2e/test/clients/` | The published client libraries against a live server | Client/server policy divergence; cross-client convergence | host + live server |
| 12 | E2E Supabase | `opto-sync-e2e/test/supabase/` | The REST/PostgREST persistence path with JWT auth | Everything specific to `rust-mash`, which no other suite touches | docker |

---

## 2. Core: unit + property tests

```sh
cd syncer.c/core
make              # == make test prop
```

Measured output (clean tree, `make clean && make`, 4.9 s total):

```
=== Results: 44/44 passed ===
prop_test: all properties held over 3000 idempotency pairs, 500x5 strategy runs, 1000 corruption runs
```

**44 unit tests.** The count in `=== Results: N/N passed ===` is derived from the
`TEST(...)` lines in `main`, not hardcoded. Adding a test means adding a
`static void test_x(void)` and a matching `TEST(test_x);`.

### What `prop_test.c` actually asserts

Deterministic by construction: a fixed-seed xorshift PRNG, no `time()`, no
`rand()`. The generator emits DB-record-shaped documents — root always an
object, arrays of `{id, updatedAt, createdAt, p}` rows, nesting capped at 4.

| Property | Loop | What it checks |
|---|---|---|
| P1 valid output | 3000 pairs | every merge result re-parses through yyjson |
| P2 idempotency (`MERGE_BY_KEY` + LWW/FWW) | 3000 pairs | `merge(merge(a,b), b) == merge(a,b)` byte-for-byte |
| P2b per-strategy idempotency | 600 pairs × 4 strategies | the same for `REPLACE`, `UNION`, `MERGE_BY_INDEX`, `MERGE_BY_KEY`. `APPEND` is excluded — concatenation is deliberately not idempotent |
| P4 termination + validity | 500 pairs × 5 strategies | every strategy terminates and yields valid JSON, with `resolve_by_timestamp` toggled |
| P3 corruption robustness | 1000 pairs | a byte is overwritten and/or the tail truncated; the merge must return a valid document or `NULL`, never crash |

The generator is written to stay **inside the contract**: it tracks an `id_mask`
and a key `mask` so no object gets duplicate keys and no array gets a duplicate
identity. That constraint is the interesting part — it exists because randomized
testing is what *discovered* the two out-of-contract input classes now documented
in [`MERGE_SEMANTICS.md`](./MERGE_SEMANTICS.md#documented-out-of-contract-inputs):

- **duplicate keys in one object** — lookups bind to the first occurrence, so
  repeated application is not stable;
- **duplicate identity values in one array** under `MERGE_BY_KEY` — duplicate
  matches bind to the first element.

No hand-written unit test would have produced either shape, because no
serializer emits them. The property suite produced them immediately, and the
outcome was a documented contract boundary rather than a "fix".

### Sanitizers

```sh
cd syncer.c/core
make sanitize     # 33 s; rebuilds both suites with -fsanitize=address,undefined
```

Same 44/44 and the same property line, under ASan + UBSan.

> **On macOS this is necessary but not sufficient.** Apple's clang ships no
> LeakSanitizer, so `detect_leaks` is unimplemented — a leaked allocation passes
> silently. Real leak detection lives in layer 4.

---

## 3. Fuzzing (`core/test/fuzz/`)

Four libFuzzer harnesses. Everything runs inside a throwaway Linux clang
container via a single `docker run` — **never** `docker compose` — because macOS
clang ships neither `libclang_rt.fuzzer_osx.a` nor LeakSanitizer.

```sh
cd syncer.c/core/test/fuzz

./run_fuzz.sh                    # all four harnesses, 60 s each, then the leak check
./run_fuzz.sh fuzz               # fuzzing only
./run_fuzz.sh leaks              # ONLY LSan over test_syncer + prop_test
./run_fuzz.sh repro crashes/fuzz_merge-crash-<sha1>
```

### Modes

| Mode | Does |
|---|---|
| `all` (default) | build → fuzz each harness → leak pass over the grown corpus → LSan over `test_syncer` and `prop_test` |
| `fuzz` | build + fuzz + per-harness leak pass; skips the suite leak check |
| `leaks` | only rebuilds `test_syncer` and `prop_test` under Linux ASan+UBSan+LSan and runs them |
| `repro <artifact>` | rebuilds the harness implied by the artifact's filename prefix and replays that single input |

### Knobs

| Env | Default | Notes |
|---|---|---|
| `DURATION` | `60` | Seconds **per harness**. A CI budget, not a campaign. |
| `JOBS` | `1` | Parallel libFuzzer workers; `-jobs/-workers` are only passed when `> 1`. |
| `MAX_LEN` | `4096` | Max input bytes. |
| `IMAGE` | `silkeh/clang:latest` | Any image with clang + compiler-rt. |
| `SAVE_CORPUS` | `0` | `1` copies the grown corpus back into `corpus_*/`. |
| `RSS_LIMIT_MB` | `2560` | libFuzzer memory cap. |
| `HARNESSES` | all four | Space-separated subset. |

Verified invocation (this exact command was run):

```sh
DURATION=10 HARNESSES=fuzz_merge ./run_fuzz.sh fuzz
# → 1,354,622 execs at ~123k exec/s, cov 3054, ft 10560, new_units 8153
# → RESULT: CLEAN
```

Wall clock is dominated by the **build**, not the fuzzing: `yyjson.c` is ~23k
lines and is instrumented once per sanitizer variant (≈2 min for both variants of
one harness). So a `DURATION=10` smoke run and a `DURATION=60` run cost almost
the same. A real campaign is
`DURATION=3600 JOBS=8 SAVE_CORPUS=1 ./run_fuzz.sh fuzz`.

### The two sanitizer variants

| Variant | Link flags | Why it exists |
|---|---|---|
| `_asan_ubsan` | `-fsanitize=fuzzer,address,undefined` | primary; catches memory errors and UB |
| `_asan_lsan` | `-fsanitize=fuzzer,address` | leak attribution with **no UBSan diagnostics in the way**, and ~3× the executions in the same wall clock |

Linux ASan enables LSan by default, so the primary variant detects leaks too —
the split exists purely so a leak report is unambiguous. The leak pass replays
the corpus the fuzzing pass just grew, and libFuzzer always re-executes the whole
corpus at startup, so every input already discovered is checked under LSan before
any new mutation happens.

Coverage flags: `-fsanitize-coverage=trace-cmp,trace-div,trace-gep`. `trace-cmp`
is the decisive one — nearly every semantic branch in the engine is a string
compare against a configured key name (`"updatedAt"`, `"id"`), and without
comparison tracing the fuzzer has to guess those literals byte by byte.

### Harnesses

All four pack two documents into one input, split on ASCII **RS `0x1E`**
(`FUZZ_SEP` in `fuzz_util.h`), which never appears unescaped in JSON text. No
separator = self-merge.

| Harness | Control prefix | Targets |
|---|---|---|
| `fuzz_merge.c` | none | the configuration real clients use: `MERGE_BY_KEY` + `resolve_by_timestamp`, `lww="updatedAt,syncedAt"`, `fww="createdAt"`, `match="id"`; merges both directions |
| `fuzz_strategies.c` | 3 bytes | the **options** too: `strategy = b0 % 5`, `max_depth = b1 % 9`, `b2` selects `detect_circular_refs`, `resolve_by_timestamp` and one of four key sets (including spacey and degenerate `,,` lists); also re-merges its own output and the one-sided `NULL` calls |
| `fuzz_callback.c` | 2 bytes | override-callback paths and the legacy `syncer_merge_json` API; `b0` picks decline / echo v1 / echo v2 / unparseable / `""` / container / alternate. Every branch has a `free()` the engine owns — exactly what LSan can check |
| `fuzz_idempotent.c` | 1 byte | a **property**, not just memory safety: `merge(merge(a,b),b) == merge(a,b)` for the four strategies that promise it |

`fuzz_idempotent` filters out-of-contract inputs (duplicate object keys,
duplicate array identities, using the same int-vs-string identity normalisation
the engine uses) before asserting — otherwise it would report a steady stream of
non-bugs. Those inputs are still fuzzed hard for *memory safety* by the other
three harnesses; the `oob_*` seeds exist to keep them covered.

### Seeds

`gen_corpus.py` regenerates all four corpora deterministically from one list of
document *pairs*; `run_fuzz.sh` generates them on demand if `corpus_*` is absent.

```sh
python3 gen_corpus.py      # idempotent, < 1 s
```

Current tracked seed counts: `corpus_merge` 54, `corpus_idempotent` 216,
`corpus_callback` 432, `corpus_strategies` 486.

Seeds matter more than mutation here: the engine only reaches its semantic
branches when the same key names line up on **both** sides, and random byte
mutation essentially never invents that alignment. Every seed is a pair that
already lines up.

### Reproducing a crash

Artifacts land in `core/test/fuzz/crashes/` as
`<harness>-crash-<sha1>` / `<harness>-leak-…` / `<harness>-timeout-…`. Harness
names use underscores and the prefix is separated by a hyphen, so the runner
infers which harness to rebuild from the filename alone:

```sh
./run_fuzz.sh repro crashes/fuzz_merge-crash-0f2a9c...
```

To inspect an artifact by eye, remember the `0x1E` split:

```sh
tr '\036' '\n' < crashes/<artifact>     # one document per line
xxd crashes/<artifact> | head           # control-byte prefix, where there is one
```

**A crash is not fixed until its reproducer is a deterministic unit test in
`core/test/test_syncer.c`.** The corpus is not a regression suite;
`test_syncer.c` is. `test_nul_in_key_not_truncated` is the worked example — found
while building these harnesses, and now runnable with no fuzzer at all.

---

## 4. Differential (`test-differential/`)

The strongest claim in the repo.

```sh
cd syncer.c/test-differential
./run_all.sh
```

Measured: **305 corpus lines, byte-identical across C, TypeScript, Dart, Rust and
Go**, in 23.7 s including a node-gyp rebuild. Requires `cc`, `node`, `dart`,
`cargo`, `go`, and `core/build/libsyncer.{dylib,so,dll}` for the Dart FFI runner.

Actual output:

```
== [3/4] pass 1: differential merge ==
OK: 305 lines byte-identical across c, ts, dart, rust, go

== [4/4] pass 2: idempotency (re-merge own output with same incoming) ==
OK: 305 lines byte-identical across pass1-c,    pass2-c
OK: 305 lines byte-identical across pass1-ts,   pass2-ts
OK: 305 lines byte-identical across pass1-dart, pass2-dart
OK: 305 lines byte-identical across pass1-rust, pass2-rust
OK: 305 lines byte-identical across pass1-go,   pass2-go
OK: 305 lines byte-identical across c, ts, dart, rust, go
ALL PASSES OK
```

Two passes, six comparisons. Pass 1 is cross-language agreement. Pass 2 re-pairs
each language's *own* pass-1 output with the original incoming document and
requires the result to reproduce pass 1 byte-for-byte — per language *and* across
languages. So a binding cannot pass by being consistently wrong in a way that
happens to be stable.

All five runners use identical options: `arrayStrategy=MERGE_BY_KEY(4)`,
`resolveByTimestamp=true`, `lwwKeys="updatedAt,syncedAt"`, `fwwKeys="createdAt"`,
`arrayMatchKeys="id"`, `maxDepth=0`, no callback.

### Why it force-rebuilds

Neither node-gyp nor Go's build cache tracks the core C sources they embed
(`syncer_core.c` `#include`s them from outside the package directory). So
TypeScript and Go can silently run an **outdated merge engine** while every test
passes. This has happened for real: a differential run showed TS and Go
disagreeing with C/Dart/Rust purely because their embedded core was older.

`run_all.sh` therefore:

- rebuilds `bindings/typescript/build/Release/syncer.node` whenever it is older
  than `../core/src/syncer.c`, `../core/src/yyjson.c` or `../bindings/typescript/src/addon.cc`;
- builds the Go runner with `go build -a`.

The corpus is generated by `gen_corpus.js` with a seeded mulberry32 PRNG and
**string concatenation** rather than `JSON.stringify` of JS numbers, so int64
timestamps like `1689940800123456789` survive verbatim. Runners split each line
textually on the first `,"incoming":` — never with a JSON parser, which would
round those integers. The generator guarantees no key or string value contains
the substring `incoming`; **keep that invariant if you extend the pools.**

---

## 5. Per-binding suites

| Binding | Command | Measured result | Time |
|---|---|---|---|
| TypeScript | `cd bindings/typescript && node test.js` | 21 PASS | 82 ms (with the concurrency file) |
| TypeScript concurrency | `node test-concurrency.js` | 2 PASS | included above |
| WebAssembly | `cd bindings/wasm && npm test` | 35 pass / 0 fail | 0.95 s |
| Dart FFI | `cd bindings/dart && dart pub get && dart bin/test.dart` | 29 PASS | 0.9 s |
| Rust | `cd bindings/rust && cargo test` | 12 unit + 3 concurrency + 0 doc | 0.55 s |
| Go | `cd bindings/go && go test -race -count=1 ./...` | 10 tests, race-clean | 8.6 s |
| BEAM | `docker run --rm -v "$PWD":/src -w /src/bindings/beam opto-sync-beam-test sh -c 'mix deps.get && mix test'` (from `syncer.c/`) | 35 tests + 4 doctests, **1 failing** at time of writing ([see below](#the-beam-version-doctest)) | minutes (cargo release build of the NIF dominates) |

The Dart runner needs the shared library:

```sh
cd syncer.c/core && mkdir -p build && cd build && cmake .. && make syncer
```

Build the BEAM image once, from `syncer.c/bindings/beam`:

```sh
docker build -f Dockerfile.test -t opto-sync-beam-test .
```

`go test -count=1` and `cache: false` are not optional — see
[COMPATIBILITY.md](./COMPATIBILITY.md#stale-artifact-hazard).

#### The BEAM version doctest

The BEAM suite currently reports `4 doctests, 35 tests, 1 failure`. The failure is
a doctest in `bindings/beam/lib/syncer.ex` that pins the version **exactly**:

```
iex> Syncer.version()
"0.2.0"          # left: "0.2.1", right: "0.2.0"
```

It is a live example of the trap in §10: an exact pin fails on every patch bump.
The fix is a lower-bound assertion, not a new literal.

### The concurrency suites

These exist because the core keeps exactly one piece of mutable state: a
`__thread` thread-local holding the *legacy* `syncer_merge_json` callback. The
`syncer_merge_json_ex` path is stateless. Each binding proves that separately,
because the bug would live in the binding glue, not the core.

| Suite | Shape |
|---|---|
| `bindings/go/concurrency_test.go` | `TestConcurrentMergeWithOptions`: 100 goroutines × 100 merges on shared inputs, every result byte-identical to the single-threaded one. `TestConcurrentMixedWorkloads`: 25 goroutines per workload running *different* option sets simultaneously, so options must never leak between calls. Plus `BenchmarkMergeByKey` over 1000 elements. Run under `-race`. |
| `bindings/rust/tests/concurrency.rs` | 16-thread determinism, mixed workloads, and `legacy_path_and_ex_path_do_not_interfere` — which deliberately calls the legacy entry point (the only path that touches the thread-local) alongside the extended one. |
| `bindings/typescript/test-concurrency.js` | Part 1: 8 `worker_threads` × 200 merges with the full option surface, all outputs identical to the main thread's. Part 2: reentrancy — an `overrideCb` that itself calls `mergeJson`, including a nested merge that also has a callback, verifying the addon's save/restore of its `thread_local` callback slot. **Not** wired into `test.js`; run it explicitly. |

`bindings/wasm/test/wasm.test.mjs` additionally asserts that the split build and
the single-file build agree, that the generated glue references no Node builtins
(so it is browser-loadable), and includes a 5000-iteration no-leak loop over the
wasm heap.

---

## 6. ORM plugin suites

### Runnable with no database

```sh
cd syncer.c/plugins/rust/diesel && cargo test    # 3 tests
cd syncer.c/plugins/rust/sqlx   && cargo test    # 4 tests
cd syncer.c/plugins/rust/seaorm && cargo test    # 4 tests
```

All 11 pass; each crate also has one ignored doctest. These are pure
reconcile-helper tests — no database is involved.

### TypeScript plugins — needs Postgres

62 registered cases across 5 modules (`core-contract`, `drizzle`, `kysely`,
`typeorm`, `prisma`); the plugin README records 61 cases / 204 assertions. Every
one is a real integration test against real Postgres and the real ORM packages.
The documented invocation (**not run here — it needs a database**):

```sh
docker run -d --name plugintest-pg -p 127.0.0.1:55987:5432 \
  -e POSTGRES_PASSWORD=test -e POSTGRES_USER=test -e POSTGRES_DB=plugintest \
  postgres:16-alpine

cd syncer.c/bindings/typescript && npm install     # the native addon must exist
cd syncer.c/plugins/typescript
npm install
npm run prisma:generate        # once; needed for the prisma suite
npm test                       # pretest type-checks, then runs every suite

docker rm -f plugintest-pg
```

Single suites: `npm run test:drizzle | test:kysely | test:typeorm | test:prisma`.
DSN override: `OPTO_SYNC_TEST_PG` (default
`postgres://test:test@127.0.0.1:55987/plugintest`).

The container is published on `127.0.0.1` at an unusual port on purpose: a stray
`kubectl port-forward` on `localhost` will shadow a Docker `0.0.0.0` publish and
hand the suite the wrong database.

Type-checking is two configurations, both run by `npm run typecheck`:
`tsconfig.json` against the ambient stubs in `types/` (so the plugins verify with
no ORM packages installed), and `tsconfig.real.json` against the **real**
packages with `types/` excluded. The second one matters: an ambient
`declare module 'kysely'` *shadows* the real package, so a stub-only check proves
nothing about the real API.

### Go GORM plugin — needs Postgres

19 tests, same throwaway container. Documented invocation (**not run here**):

```sh
docker run -d --name plugintest-pg -p 127.0.0.1:55987:5432 \
  -e POSTGRES_PASSWORD=test -e POSTGRES_USER=test -e POSTGRES_DB=plugintest \
  postgres:16-alpine

cd syncer.c/plugins/go/gorm && go test ./... -v
docker rm -f plugintest-pg
```

Without a reachable Postgres these tests **skip** rather than fail — so a green
run with no database is not coverage. Check for skips.

### BEAM / Ecto plugin — needs docker + Elixir

22 tests + 3 doctests hermetic (changesets and embedded schemas, no database),
plus 4 Postgres integration tests tagged `:integration` and excluded by default.
From the repository root, using the image built for the BEAM binding:

```sh
# hermetic
docker run --rm -v "$PWD":/src -w /src/plugins/beam/ecto opto-sync-beam-test \
  sh -c 'mix deps.get && mix test'

# with a throwaway Postgres on a NON-default port (55433)
docker network create opto-sync-beam-net
docker run -d --name opto-sync-pg --network opto-sync-beam-net \
  -e POSTGRES_PASSWORD=postgres -p 55433:5432 postgres:16-alpine

docker run --rm --network opto-sync-beam-net \
  -e PG_URL=postgres://postgres:postgres@opto-sync-pg:5432/postgres \
  -v "$PWD":/src -w /src/plugins/beam/ecto opto-sync-beam-test \
  sh -c 'mix deps.get && mix test --include integration'

docker rm -f opto-sync-pg && docker network rm opto-sync-beam-net
```

`plugins/dart/drift` has no test suite of its own; it is covered through
`opto-sync-clients/clients/dart`.

---

## 7. Client libraries (`opto-sync-clients`)

The clients are what external projects import. Their suites are the only place a
client's **default reconcile policy** is checked against the server's.

```sh
# The Dart client needs the core shared library:
cd syncer.c/core && mkdir -p build && cd build && cmake .. && make syncer

cd opto-sync-clients/clients/ts   && npm install && npm test
cd opto-sync-clients/clients/dart && dart pub get && dart test
cd opto-sync-clients/clients/rust && cargo test
```

Measured:

| Client | Result | Time |
|---|---|---|
| `clients/ts` | 43 pass / 0 fail (`npm test` = build + `node --test`) | 3.8 s |
| `clients/dart` | 8 tests, all passed | 2.1 s |
| `clients/rust` | 7 unit + 2 durability integration + 1 doctest = 10 | 5.1 s |

The TypeScript total breaks down per file as:

| File | Tests | Covers |
|---|---|---|
| `test/reconcile.test.js` | 11 | reconcile semantics through the native addon |
| `test/engine-parity.test.mjs` | 11 | wasm vs native byte-identity: 34 corpus cases, a 1000-document randomized corpus, idempotence agreement, and a guard that the two engines are genuinely different implementations rather than one stub |
| `test/browser-fallback.test.mjs` | 8 | the jsdom + fake-indexeddb path |
| `test/queue.test.js` | 4 | Dexie mutation-queue lifecycle |
| `test/bundle.test.mjs` | 4 | the browser bundle builds for `platform=browser`, references no Node builtins, does not pull in the native addon, stays within a size budget |
| `test/browser-e2e.test.mjs` | 3 | see below |
| `test/helpers/*.mjs` | 2 | **not real tests** — `node --test` treats every `.mjs` under `test/` as a test file, so the two helper modules each register as one trivially-passing "test". 41 real tests + 2 helpers = the 43 reported. |

### What `browser-e2e.test.mjs` actually drives

Real headless **Chromium via Playwright** — not jsdom, not `fake-indexeddb`. The
run measured here reported `real browser exercised: Chromium 151.0.7922.34`.

It serves the bundled browser client over a real `http://127.0.0.1:<port>` origin
and, inside the page:

1. **Asserts the environment is genuine** — `location.origin` is a real HTTP
   origin, `Object.prototype.toString.call(indexedDB) === '[object IDBFactory]'`
   (the native factory, not a shim), `WebAssembly` present, and `require`/
   `process` both **absent**, so the bundle cannot be leaning on Node.
2. **Drives real IndexedDB** — queues two mutations, marks one synced, closes the
   connection, enumerates `indexedDB.databases()` to prove the browser considers
   the database its own, reopens with a fresh client (simulating a reload), and
   then reads the records back through the **bare IDB API** rather than through
   Dexie.
3. **Runs the reconcile corpus with wasm in the page** and compares every result
   to the native-in-Node result computed in the test process. Any divergence is
   printed per scenario.
4. **Checks the optimistic guarantee end to end** — a local edit at
   `updatedAt: 5000` survives a stale server echo at `updatedAt: 10`, and a
   local-only array element survives an empty server array.
5. **Repeats the whole thing inside a real `Worker`** built from a Blob URL,
   asserting `typeof window === 'undefined'` — the worker path exercises a
   genuinely different emscripten environment branch, and is the path a real app
   uses to keep merges off the main thread.
6. If Chromium cannot be launched the tests **skip** and a third test logs
   `real browser NOT exercised`, so a skipped browser run is visible in the
   output instead of being mistaken for coverage.

Version checks in this file are deliberately lower bounds
(`maj > 0 || min > 2 || (min === 2 && patch >= 1)`), with the reasoning stated
inline: an exact pin fails on every patch bump yet still would not catch a stale
artifact reporting an *older* version.

---

## 8. End-to-end (`opto-sync-e2e`) — docker

**Do not run these casually: a shared compose stack may be in use.** Everything
in this section is documented from the compose files and scripts, not executed
here. Note that several suites deliberately never call `docker compose down`
(it would `-v` away a database other suites share) and never `POST /reset`
(it `TRUNCATE`s shared tables).

### One-time setup

The build context is the **parent** directory, so images can `COPY syncer.c/`.
Docker only honors a `.dockerignore` at the context root:

```sh
cd opto-sync-e2e
cp context.dockerignore ../.dockerignore
cp .env.example .env        # compose hard-fails on a missing env_file
```

### Servers

| Service | Port | Stack | Storage | Compose profile |
|---|---|---|---|---|
| `postgres` | 5433→5432 | `postgres:16-alpine` | — | none (always) |
| `rust-mash` | 3001 | Maud + Axum + Supabase REST + HTMX, `syncer-rs` C FFI | Supabase / PostgREST | `mash`, `supabasetest` |
| `rust-fullstack` | 3002 | Axum SSR + `syncer-rs` C FFI | in-memory | `fullstack` |
| `node` | 3003 | Express + `@opto-sync/syncer` N-API addon + Drizzle | Postgres | none (always) |
| `dart` | 3004 | Shelf + `dart:ffi` | in-memory | `dart` |
| `sagitta` | 3005 | Sagitta SSR + `dart:ffi` | in-memory | `sagitta` |

All five apply the same policy: `MERGE_BY_KEY` on `id`, `resolveByTimestamp`,
LWW `updatedAt,syncedAt`, FWW `createdAt`. The node server runs with
`SYNCER_REQUIRE_NATIVE=1` and **refuses to start without the native C addon** — a
JS fallback merge would let the entire suite pass without ever exercising the
core.

### Suites

| Suite | Profile / invocation | What it proves |
|---|---|---|
| `test/run_e2e.sh` | `docker compose --profile test up --build` | Smoke: node server health, seed docs, deep merge of nested objects. `curl` + `grep`. |
| `test/run_e2e_full.sh` | `docker compose --profile fulltest --profile fullstack --profile dart --profile sagitta up --build` | The same `test_server` function applied to node, rust-fullstack, dart and sagitta: 11 checks each covering health, deep merge persistence, stale-write handling, and **element-level** keyed-array behaviour — untouched element kept, fresher element applied, new element appended, stale element rejected, `createdAt` re-creation refused. Rejection is asserted with `check_absent`, since absence is the only proof. |
| `test/conformance/` | `docker compose --profile conformance up --exit-code-from conformance` | **12 scenario groups, 92 cases** against the Postgres-backed node server: health, deep merge, keyed arrays, jsonb fidelity, idempotency, convergence, concurrency, batch, tombstones, identity, the strategy matrix, robustness. This is the only layer that round-trips every merge through real `jsonb`, so it proves the core's output survives key reordering, numeric normalization and unicode. Iterable from the host with `BASE_URL=http://localhost:3003 node test/conformance/run.mjs`, and filterable by group number (`node run.mjs 3 6 7`). |
| `test/cross-server/` | `docker compose --profile crossserver --profile fullstack --profile dart --profile sagitta up --exit-code-from cross-server` | Four runtimes (Node/N-API+jsonb, Rust/static-link, two Dart/FFI) produce **semantically identical** documents from one mutation sequence, after different HTTP stacks and different JSON serializers. Phase 1 asserts eleven per-server properties against a reference server; phase 1b probes int64 precision per runtime (`int64Exact: false` for node, `true` for rust/dart) so the 2^53 limit is asserted rather than hidden; phase 2 applies three non-contending mutations in every permutation and requires convergence. Host mode: `HOST_MODE=1 node test/cross-server/run.mjs`. |
| `test/clients/` | `test/clients/run_all.sh` (from the host, against a live server) | The **published** client libraries from `../opto-sync-clients` (ts/dart/rust) against a live server over HTTP, every document round-tripping through `jsonb`. Seven scenarios implemented in all three languages: default policy (scenario 0), offline queue → flush → merge (1a individual, 1b batched), optimistic write → pull-back reconcile, stale-write rejection in both directions, keyed-array reconciliation, replay idempotency, failure marking, and scenario 7 — cross-client convergence, where all three clients queue different payloads against one document flushed `ts → dart → rust` and then each independently verifies the final state. |
| `test/supabase/` | `docker compose -f docker-compose.yml -f docker-compose.supabase.yml up -d --build postgrest rust-mash`, then `… --profile supabasetest run --rm supabase-test` | 77 assertions across nine groups over the REST persistence path, using a local `postgrest/postgrest:v12.2.3` as a stand-in for Supabase (Supabase's REST API *is* PostgREST). Auth is faithful, not bypassed: an HS256 anon JWT in both `apikey` and `Authorization: Bearer`, with an invalid-JWT-401 assertion proving the suite is not passing against a wide-open database. Every claim about merged state is re-verified by reading the row back through PostgREST **directly, bypassing `rust-mash`**. Host mode: `node test/supabase/run.mjs` (ports 3001 and 3010 are published). |

`test/clients/run_all.sh` accepts `ts | dart | rust` to run one language and
`--no-converge` to skip scenario 7. It aborts if `/health` does not report
`"syncer":"native"`, and skips with a clear message (exit 0) if the server is
unreachable — `OPTO_SYNC_REQUIRE_SERVER=1` turns that skip into a failure, which
is what CI sets.

Individual `test/clients` suites, if you prefer:

```sh
(cd test/clients/ts   && node --test)                                # 8 tests
(cd test/clients/dart && dart test)                                  # 8 tests
(cd test/clients/rust && cargo test --offline --test scenarios)       # 8 tests
```

### rust-mash is opt-in for a reason

`rust-mash` is behind the `mash` profile because it only functions with Supabase
credentials **or** the PostgREST override. Bringing it up from the main compose
file alone leaves it pointed at the `.env` placeholder, where every request
fails. Always include `-f docker-compose.supabase.yml` for the local path.
`SUPABASE_REST_PREFIX` (default `/rest/v1`, overridden to `""` locally because
bare PostgREST serves tables at the root) is what lets one code path serve both
targets — and the suite asserts that a `/rest/v1/...` request **404s** locally,
so the variable is proven load-bearing rather than decorative.

### What the Supabase stand-in does NOT cover

RLS policies (the biggest gap), GoTrue auth, realtime/websockets, PostgREST
version drift against Supabase's own build, the cloud gateway/rate
limits/pooler/TLS, and the Supabase client libraries. See
`test/supabase/README.md`.

---

## 9. Which layer should my new test go in?

| If you are changing / testing… | Write the test in | Because |
|---|---|---|
| Merge semantics for a specific documented case | `core/test/test_syncer.c` | Cheapest, deterministic, and it is the regression suite of record. Update `docs/MERGE_SEMANTICS.md` in the same commit. |
| A property that must hold for **all** inputs (idempotency, "output is valid JSON", "never crashes") | `core/test/prop_test.c` | Enumerated cases cannot express a universal claim; this is where the duplicate-key and duplicate-identity boundaries came from. |
| A crash or leak a fuzzer found | `core/test/test_syncer.c` **and** keep the harness | The corpus is not a regression suite. A fix is not done until it is pinned by a test that needs no fuzzer. |
| A new option, or option plumbing | `core/test/test_syncer.c` for the behaviour, then **every** per-binding suite, then `test-differential/` | An option that never reaches the core still "passes" if only one language is checked. |
| Cross-language agreement | `test-differential/` | The only layer that requires **byte** identity across five bindings. |
| A binding's error mapping, type conversion, or option naming | that binding's own suite | The core cannot see it. |
| Thread safety / reentrancy in binding glue | the binding's concurrency suite (`concurrency_test.go`, `tests/concurrency.rs`, `test-concurrency.js`) | The core's `ex` path is stateless; the bug lives in the glue's callback slot. |
| Anything about `jsonb`: key order, numeric normalization, unicode, round-trip fidelity | `opto-sync-e2e/test/conformance/` | It is the only layer with a real Postgres in the loop. |
| Locking, lost updates, CAS, missing-row handling in an ORM adapter | that plugin's suite (`plugins/typescript/test/`, `plugins/go/gorm/syncer_test.go`, `plugins/beam/ecto/test/`) | These are read-modify-write defects; they need a real database and real concurrency. |
| Multi-runtime agreement at the server level, or host-runtime numeric precision | `opto-sync-e2e/test/cross-server/` | It is the layer where four different JSON serializers are in play. |
| Client queue behaviour: offline queueing, replay, durability across reload, sync status accounting | the client's own suite in `opto-sync-clients/clients/*` | No server needed; keep it fast. |
| A client's default reconcile policy vs the server's | `opto-sync-e2e/test/clients/` | A client's own tests only prove the native merge does what the native merge does. Policy divergence is invisible without a live server. |
| Browser reality: IndexedDB, wasm, workers, bundling | `opto-sync-clients/clients/ts/test/browser-e2e.test.mjs` | jsdom and `fake-indexeddb` cannot falsify a claim about the browser. |
| The Supabase / REST persistence path | `opto-sync-e2e/test/supabase/` | `rust-mash` is the only REST-persisted component and no other suite touches it. |

---

## 10. Traps a test author must respect

| Trap | Why it bites | What to do |
|---|---|---|
| **Stale compiled core** | node-gyp does not rebuild `bindings/typescript/build/Release/syncer.node` when `core/src/*.c` changes, and Go's build cache does not fingerprint the core sources `syncer_core.c` `#include`s from outside the package. Both can run last week's engine while every test passes. | Force a rebuild (`npm run build`, `go build -a`, `go test -count=1`). Never cache compiled output in CI. |
| **Stale shared library** | `core/build/libsyncer.dylib` is not rebuilt by `make`, only by `cmake --build`. Encountered live while writing this document: the Dart binding suite reported core `0.2.0` while `core/src/syncer.c` said `0.2.1`. | Rebuild before any Dart-FFI or differential run: `cd core/build && cmake .. && make syncer`. |
| **`jsonb` reorders object keys** and drops duplicates | Merge output is only ever *semantically* stable across a `jsonb` round trip, never byte-stable. A text comparison is meaningless. | Compare **parsed values**. This is also why `UNION` compares structurally rather than by serialized text. |
| **Integers past 2^53** | Any JavaScript layer — a browser, `express.json`, even a test harness — silently rounds `1689940800123456789` to `…800`. Rust and Dart are exact. | Use **digit strings** for sub-millisecond timestamps; the core compares pure-digit strings numerically. In generators, build JSON by string concatenation and split corpus lines textually, never via `JSON.parse`. |
| **Exact version pins** | A pin fails on every patch bump, *and* still passes a stale artifact reporting an older version. Live example: `bindings/beam/lib/syncer.ex` has a doctest pinning `Syncer.version()` to `"0.2.0"`, which fails today against the 0.2.1 core. | Assert a **lower bound** (`maj > 0 \|\| min > 2 \|\| (min === 2 && patch >= 1)`), and a `major.minor.patch` shape. |
| **In-memory e2e servers accumulate state** | `rust-fullstack`, `dart` and `sagitta` have no `/reset`, so a fixed document key makes a suite compare a fresh server against one carrying keys from an earlier run — a spurious "runtimes disagree" failure. | **Namespace per run.** `cross-server` uses `NS_SUFFIX ?? "p<pid>"`; `test/clients` uses `cl-<lang>-<scenario>`; the Supabase suite uses `sb-<pid>-<time>` and deletes only that prefix. |
| **`POST /reset` and `docker compose down`** | `/reset` `TRUNCATE`s tables and `down -v` destroys a database other suites are using concurrently. | Create fresh documents with `PUT /doc/:id` instead. Tear down individual services with `stop`. |
| **Skips that look like passes** | The GORM plugin skips without Postgres; `test/clients` skips without a server; `browser-e2e` skips without Chromium. | Read the output for skips, or set `OPTO_SYNC_REQUIRE_SERVER=1`. `browser-e2e` logs an explicit line either way. |
| **`node --test` in a `test/` directory** | It treats every `.mjs`/`.js` under `test/` as a test file, so helper modules register as trivially-passing tests (2 of the 43 in `clients/ts`). | Do not read the total as a count of assertions; check per-file counts. |
| **Absence is the only proof of rejection** | "The stale write lost" cannot be shown by asserting what *is* present. | Use a negative assertion: `assert(strstr(r, "stale-a") == NULL)` in C, `check_absent` in the shell suites. |
| **Unseeded randomness** | A generator using `Math.random()` or `Date.now()` produces failures nobody can reproduce. | Seeded PRNGs only: xorshift in `prop_test.c`, mulberry32 in `gen_corpus.js`, deterministic output in `gen_corpus.py`. |

---

## 11. Before you push

```sh
cd syncer.c/core           && make && make sanitize
cd syncer.c/test-differential && ./run_all.sh
```

Then the suites for whatever you touched. See
[`../CONTRIBUTING.md`](../CONTRIBUTING.md) for the full gate and the checklist
for adding a merge option.
