# Contributing to syncer.c

Read these two documents first. They are the contract, not commentary:

- [`docs/MERGE_SEMANTICS.md`](docs/MERGE_SEMANTICS.md) — what a merge does.
  Change it in the same commit as any behaviour change.
- [`docs/COMPATIBILITY.md`](docs/COMPATIBILITY.md) — versioning, the options-struct
  ABI rules, and the stale-artifact hazard. **Read this before adding an option.**

[`docs/TESTING.md`](docs/TESTING.md) maps every suite across the three repos and
tells you which layer a new test belongs in.

---

## 1. Repository layout, and where a change belongs

```
core/                the engine (C99, vendored yyjson, no other dependencies)
  include/syncer.h   the public API and the options struct
  src/syncer.c       the whole engine
  test/              unit + property suites, fuzz harnesses
bindings/            typescript (N-API) · wasm · dart (FFI) · rust · go (cgo) · beam (Rustler NIF)
plugins/             ORM adapters: drizzle · prisma · kysely · typeorm · diesel · sqlx · seaorm · gorm · ecto
test-differential/   proves all five bindings produce byte-identical output
docs/                the contract, compatibility rules, this test map
```

Sibling repositories: [`opto-sync-clients`](../opto-sync-clients) (offline queue,
IndexedDB/SQLite, transport) and [`opto-sync-e2e`](../opto-sync-e2e) (servers and
end-to-end suites).

| Kind of change | Belongs in |
|---|---|
| Merge behaviour of any kind | `core/src/syncer.c` **only** |
| A new option or strategy | `core/` first, then propagated outward (§3) |
| Error mapping, naming, type conversion for one language | that binding |
| Read-merge-write / locking / CAS against a database | that plugin |
| Offline queue, local storage, transport | `opto-sync-clients` |
| A server, HTTP shape, or a scenario needing a real database | `opto-sync-e2e` |

### The rule: merge semantics live only in the core

No binding, plugin, client or server may implement, patch, reorder or
special-case a merge. Every one of them delegates to `syncer_merge_json_ex`. This
is the whole premise of the project — a browser, a Node server, a Dart app, a
Rust service and an Elixir worker resolve the same conflict the same way — and it
is enforced mechanically by `test-differential/`, which fails unless all five
bindings emit **byte-identical** output.

Two consequences worth stating plainly:

- A binding that "fixes up" a result to look nicer breaks byte-identity and will
  fail the differential suite.
- A behaviour that is only correct in one language is a core bug, not a binding
  workaround.

The `opto-sync-e2e` node server is configured with `SYNCER_REQUIRE_NATIVE=1` and
**refuses to start without the native addon** for the same reason: a JS fallback
merge would let an entire suite pass without ever exercising the core.

---

## 2. Code style, as observed in `core/src/syncer.c`

- **C99, libc + vendored `yyjson` only.** No new dependencies.
- **Iterative, never recursive.** Merging is a DFS over an explicit heap stack
  (`merge_stack_t`); structural comparison has its own (`eq_stack_t`). A
  pathologically deep document must not overflow the C stack — this is tested to
  1000 levels by `test_extreme_depth`. If you add a tree walk, add a stack.
- **Every growable buffer carries an `oom` flag.** `path_buf_t`, `visited_set_t`,
  `merge_stack_t`, `eq_stack_t` all follow the same shape: on allocation failure
  keep the last valid state, set `oom`, and let the caller abort. The merge then
  returns `NULL` rather than emitting a partial document. Never assume `malloc`
  or `realloc` succeeded; never lose the old pointer on a failed `realloc`.
  Structural comparison reports "not equal" on OOM — an element may be appended
  twice, never corrupted.
- **`NULL` means failure, never empty.** `syncer_merge_json_ex` returns `NULL`
  only on parse failure or allocation failure. Bindings must surface that as
  `null`/`None`/`{:error, _}`/an exception, never as `""`.
- **Length-explicit key handling.** Keys are looked up and recreated with an
  explicit length, never `strlen()`. JSON keys may legally contain an escaped
  NUL; truncating at it caused a real data-corruption bug (see
  [CHANGELOG](CHANGELOG.md) 0.2.1). If you touch key handling, carry the length.
- **`static` everything that is not in `syncer.h`.** The public surface is the
  header, and nothing else.
- **Warnings are errors in practice.** The suites build with `-Wall -Wextra`;
  keep the build silent.
- **Comments state constraints, not narration.** The existing comments explain
  *why* a thing must be true ("MUST remain the LAST field", "old buf stays valid;
  freed in path_free"). Match that register.

---

## 3. Checklist: adding a merge option

`syncer_merge_options_t` is an **ABI contract**. The Dart and Rust bindings mirror
it field-for-field, and a mirror that is one field short leaves the core reading
uninitialized memory past the end of the allocation — which usually "works" until
it doesn't. This has already happened once: `array_match_keys` was added in 0.2.0
and every mirror plus two e2e servers needed updating in lockstep.

Work through this in order. Do not skip a step because "the tests pass" — several
of these failure modes are silent.

1. **Confirm the option belongs in the core at all.** If it can be expressed by
   existing options, or is really a host-language convenience, it does not go in
   the struct.

2. **Append the field to the end of `syncer_merge_options_t`** in
   `core/include/syncer.h`. **Append only** — never reorder, never remove, never
   insert in the middle. Document its meaning and its `NULL`/zero default in a
   comment beside it, and note if it must stay last.

3. **Initialize it in `syncer_default_options()`** in the same header. Every
   field is set explicitly there; a missing line is garbage, not a default.

4. **Implement the behaviour in `core/src/syncer.c`,** honoring §2 (iterative,
   `oom`-flagged, length-explicit).

5. **Bump the version.** New option = **minor** bump per
   [COMPATIBILITY.md](docs/COMPATIBILITY.md). Update the string returned by
   `syncer_version()` in `core/src/syncer.c` (currently at line ~1090).

6. **Update `docs/MERGE_SEMANTICS.md`** in the same commit. It is the contract
   under test; an option that is not described there does not exist.

7. **Update both ABI struct mirrors.** These are the silent-failure ones:
   - `bindings/dart/lib/syncer.dart` — `final class SyncerMergeOptionsC extends Struct`
   - `bindings/rust/src/lib.rs` — `#[repr(C)] pub struct SyncerMergeOptionsC`

   Both currently carry a "MUST remain the LAST field" comment on
   `array_match_keys`; move that annotation to your new last field.

8. **Update every consumer that constructs the struct directly.** As of today
   that is two e2e servers:
   - `../opto-sync-e2e/servers/rust/src/main.rs` (`rust-mash`)
   - `../opto-sync-e2e/servers/rust-fullstack/src/main.rs`

   Prefer starting from `syncer_default_options()` everywhere, so a missed field
   is a default rather than garbage.

9. **Expose the option through every binding.** The bindings that do *not* lay
   out the struct still need the plumbing:

   | Binding | Files |
   |---|---|
   | TypeScript | `bindings/typescript/src/addon.cc`, `index.ts`, `index.js`, `index.d.ts` |
   | WebAssembly | `bindings/wasm/src/syncer_wasm.c` (add an argument to **both** `syncer_merge_flat` and `syncer_merge_flat_cb`), `lib/wrap.mjs`, `index.d.ts`; rerun `build.sh` and check `EXPORTED_FUNCTIONS` if you add an exported symbol |
   | Dart | `bindings/dart/lib/syncer.dart` (the mirror from step 7 plus the Dart-facing API) |
   | Rust | `bindings/rust/src/lib.rs` (the mirror plus `MergeOptions`) |
   | Go | `bindings/go/syncer.go` — `Options`; keep building from `C.syncer_default_options()` and setting fields |
   | BEAM | `bindings/beam/lib/syncer.ex` (validation + `crdt_options/1`) and `bindings/beam/native/syncer_nif/src/lib.rs` |

   Prefer the **flat-argument shim** pattern the WebAssembly binding uses for any
   *new* binding: passing scalars across the boundary makes struct layout a
   non-issue.

10. **Expose it through the clients** in `../opto-sync-clients`, whose defaults
    must stay aligned with the servers':
    - `clients/ts/src/engine.ts`, `clients/ts/src/reconcile-core.ts`
    - `clients/dart/lib/opto_sync_client.dart`
    - `clients/rust/src/lib.rs`

11. **Extend the plugins if the option is meaningful for an ORM path:**
    `plugins/typescript/{drizzle,kysely,typeorm,prisma}/index.ts`,
    `plugins/rust/{diesel,sqlx,seaorm}/src/lib.rs`,
    `plugins/go/gorm/syncer.go`, `plugins/beam/ecto/lib/ecto_syncer.ex`.

12. **Add a core unit test** in `core/test/test_syncer.c` (a
    `static void test_x(void)` plus a `TEST(test_x);` line in `main`). Assert both
    directions: the option on *changes* the outcome, and the option off leaves it
    unchanged. If the option promises idempotency, add it to the strategy list in
    `core/test/prop_test.c`.

13. **Add it to a per-binding test** for each binding, so a broken plumbing job
    fails loudly instead of silently defaulting.

14. **Re-run the differential suite.** This is the acceptance gate:

    ```sh
    cd core/build && cmake .. && make syncer      # the Dart runner needs a fresh shared lib
    cd ../../test-differential && ./run_all.sh
    ```

    It fails unless all five bindings produce byte-identical output over 305
    pairs, twice. If your option changes results for the corpus's option set,
    that is a semantics change — see step 6 and the versioning policy.

15. **Re-run the sanitizers:** `cd core && make sanitize`.

16. **Update `CHANGELOG.md`** under a new `Added` entry, and update the `Status`
    section of `README.md` if the version moved.

### Adding an array strategy

Same list, plus: extend `syncer_array_strategy_t` **by appending** a value (the
numeric values are part of the wire contract — TypeScript's `ArrayStrategy` map,
Rust's `ArrayMergeStrategy`, Go's constants and the WebAssembly shim's `int`
argument all depend on them), mirror it in every binding's enum, and state in
`docs/MERGE_SEMANTICS.md` whether it is idempotent. If it claims idempotency, add
it to the `idem[]` array in `core/test/prop_test.c` and to `fuzz_idempotent.c`.

---

## 4. What must pass before a change lands

Always:

```sh
cd core && make                         # 44 unit tests + property suite
cd core && make sanitize                # the same under ASan + UBSan
```

If you touched `core/src`, `core/include`, any binding, or anything the
differential harness runs:

```sh
cd core/build && cmake .. && make syncer            # refresh the shared library
cd test-differential && ./run_all.sh                # 305 pairs, five bindings, two passes
```

Per binding, whichever you touched:

```sh
cd bindings/typescript && npm install && node test.js && node test-concurrency.js
cd bindings/wasm       && npm test
cd bindings/dart       && dart pub get && dart bin/test.dart
cd bindings/rust       && cargo test
cd bindings/go         && go test -race -count=1 ./...
# BEAM (from syncer.c/):
docker run --rm -v "$PWD":/src -w /src/bindings/beam opto-sync-beam-test \
  sh -c 'mix deps.get && mix test'
```

Plugins:

```sh
cd plugins/rust/diesel && cargo test    # and sqlx, seaorm — no database needed
cd plugins/typescript  && npm run typecheck && npm test   # needs Postgres, see docs/TESTING.md
cd plugins/go/gorm     && go test ./... -v                # needs Postgres, otherwise SKIPS
```

If you touched merge semantics or anything a server exercises, run the relevant
`opto-sync-e2e` suite. Those need docker; the invocations are in
[`docs/TESTING.md`](docs/TESTING.md#8-end-to-end-opto-sync-e2e--docker). **Check
with whoever else is using the stack first** — several suites share one Postgres
and must not be `docker compose down`ed.

If a fuzz campaign found the bug you are fixing, run
`core/test/fuzz/run_fuzz.sh` (Docker) and add the reproducer to
`core/test/test_syncer.c`. The corpus is not a regression suite.

---

## 5. CI expectations

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs on `ubuntu-latest`
for every push to `main`, every pull request, and on demand. Runs on the same ref
are cancelled when superseded.

| Job | Matrix legs | Runs | Timeout |
|---|---|---|---|
| `core` | `tests`, `sanitize` | `make all` / `make sanitize` in `core/` | 15 min |
| `bindings` | `typescript`, `rust`, `go`, `dart` | `node test.js` + `node test-concurrency.js`; `cargo test`; `go test -race -count=1 ./...`; `dart pub get && dart bin/test.dart` | 25 min |
| `plugins` | `rust-diesel`, `rust-sqlx`, `rust-seaorm`, `typescript`, `go-gorm` | `cargo test`; `tsc -p tsconfig.json`; `go build ./... && go vet ./...` | 20 min |
| `differential` | — | `test-differential/run_all.sh` | 35 min |

`fail-fast: false` everywhere, and every job ends with a "Which suite broke" step
that prints the exact reproduction command, so one red check is legible on its
own.

Things about this workflow that are load-bearing:

- **The caching arrangement is deliberate. Do not "optimize" it.** `setup-go` has
  `cache: false`; the cargo cache covers `~/.cargo/registry` and `~/.cargo/git`
  only, never `target/`; `setup-node` caches `~/.npm` only, never `node_modules`
  or `build/Release/syncer.node`. Restoring compiled output could let the
  differential job validate a **stale core** and report five languages agreeing
  on last week's behaviour.
- **`-count=1` on `go test`** defeats Go's test-result cache, which would
  otherwise return a meaningless cached PASS.
- **The Dart leg builds `core/build/libsyncer.so`** via CMake, and the
  differential job symlinks `libsyncer.dylib → libsyncer.so` because
  `run_all.sh` and `run_dart.dart` still carry macOS-only defaults. Do not remove
  that symlink step until those defaults are fixed. Scripts must derive the
  library name from the platform and must honor a pre-set `SYNCER_LIB_PATH`.
- **The TypeScript legs `npm install` first** so node-gyp compiles the addon from
  the current core sources — and so `run_all.sh`'s staleness check is satisfied
  by an addon that genuinely matches them.
- **`plugins (typescript)` is type-check only** in CI: the ORM packages are peer
  dependencies and are intentionally not installed, with
  `plugins/typescript/types/orm-stubs.d.ts` modelling their surface. The real
  integration suite needs Postgres and is run locally (see §4). Note that CI runs
  only `tsconfig.json`; `npm run typecheck` locally also runs `tsconfig.real.json`
  against the real packages, which is the config that catches stub-shadowed API
  defects.
- **`plugins (go-gorm)` is build + vet only**, because its tests need Postgres.

The sibling repositories have their own workflows: `opto-sync-clients/.github/workflows/ci.yml`
(one leg per client), and in `opto-sync-e2e`, `e2e-docker.yml` (one leg per docker
suite: `fulltest`, `conformance`, `crossserver`, `supabase`) and `e2e-clients.yml`
(the host-run `test/clients/run_all.sh` with `OPTO_SYNC_REQUIRE_SERVER=1`). All of
them check out the three repos as **siblings** under `$GITHUB_WORKSPACE`, because
every path dependency and docker build context is relative.

---

## 6. Test-writing conventions used in this tree

These are not aspirational; they are what the existing suites do.

**Prove a rejection by absence.** A stale write losing cannot be shown by
asserting what *is* present. The C suite uses negative assertions:

```c
assert(strstr(r, "stale-a") == NULL);
assert(strstr(r, "impostor") == NULL);
assert(strstr(r, "},{") == NULL);      /* no duplicate element was appended */
```

The shell suites have a dedicated `check_absent` helper for exactly this, with the
reason written above it: *"Stale-write rejection can only be proven by absence, so
`check` alone cannot express it."*

**Version assertions are lower bounds, never exact pins.** An exact pin fails on
every patch bump *and* still passes a stale artifact reporting an older version.
The pattern in use:

```js
const [maj, min, patch] = String(v).split('.').map(Number);
assert.ok(maj > 0 || min > 2 || (min === 2 && patch >= 1), `unexpected core version ${v}`);
```

Also assert the shape (`/^\d+\.\d+\.\d+$/`), as `bindings/wasm/test` does, or a
minimum length, as `test_version_string` does. This convention is what caught a
stale addon that an exact pin would have passed.

**Randomness must be deterministic and seeded.** No unseeded `rand()`, no
`Math.random()`, no `Date.now()` in a generator. `prop_test.c` uses a fixed-seed
xorshift and says so in its header comment; `test-differential/gen_corpus.js` uses
a fixed-seed mulberry32; `core/test/fuzz/gen_corpus.py` is idempotent. A failure
nobody can reproduce is not a finding.

**Compare parsed values, not text, whenever a database is involved.** Postgres
`jsonb` reorders object keys and normalizes whitespace, so byte comparison is
meaningless there. Byte comparison belongs to `test-differential/` (no database)
and nowhere else. Conversely, when precision is the thing under test, compare the
**raw response text** — the Supabase suite does this so JS number handling cannot
mask a loss.

**Re-read persistence through an independent path.** The plugin suites re-read
through a raw `pg` connection, never through the ORM under test; the Supabase
suite re-reads through PostgREST, bypassing the server that wrote the row. An
in-memory-only merge must not be able to pass.

**Namespace anything that touches shared state.** The in-memory e2e servers have
no `/reset` and accumulate state, so every suite namespaces per run:
`NS_SUFFIX ?? "p<pid>"` in `cross-server`, `cl-<lang>-<scenario>` in
`test/clients`, `sb-<pid>-<time>` in the Supabase suite. Never call
`POST /reset` (it `TRUNCATE`s tables other suites are using) and never
`docker compose down -v` a shared stack.

**A regression test must have been seen to fail.** Every plugin defect fix in this
tree was verified against the unfixed code first. A test that would pass either
way is worse than no test.

**Comments state constraints, not narration.** Compare:

```c
/* Identity values are unique within one array, per the MERGE_BY_KEY
   contract in syncer.h — mirroring rows keyed by a primary key. */
```

against "loop over the array". The first tells the next author what they may not
break. Where a test pins a documented sharp edge, name it: `test_override_reaches_arrays`,
`test_union_dedup_key_order_independent`, `test_nul_in_key_not_truncated`.

**A skip is not a pass.** The GORM plugin skips without Postgres, `test/clients`
skips without a server, `browser-e2e` skips without Chromium. Where a skip could
be mistaken for coverage, make it visible — `browser-e2e` logs
`real browser NOT exercised` as an explicit test — and give CI a way to make it
fatal (`OPTO_SYNC_REQUIRE_SERVER=1`).

---

## 7. Commits and versioning

- Semantic versioning as defined in
  [COMPATIBILITY.md](docs/COMPATIBILITY.md#semantic-versioning-policy): **patch**
  for fixes that do not change documented results, **minor** for new options,
  strategies or bindings, **major** for any change to documented semantics of an
  existing option. Remember that a minor bump can still be an **ABI break** for
  the struct mirrors.
- Commit messages in this repo are long and specific: what changed, why, what it
  broke before, and the test that pins it. Keep that. The
  [CHANGELOG](CHANGELOG.md) is reconstructed from them.
- Behaviour change and its documentation land in the **same commit**.
