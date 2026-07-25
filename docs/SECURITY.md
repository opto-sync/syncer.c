# Security posture

What has actually been tested, what those tests do and do not prove, and what
is not covered at all. Every claim below cites the file that backs it. Nothing
here is a guarantee of security; it is a description of evidence.

**No formal security audit has been performed.**

---

## 1. Memory safety of the C core

The core is C99 (`core/src/syncer.c` plus vendored `yyjson`), so memory safety
is a testing question, not a language guarantee.

### What has been run against it

| Tool | Over what | Where it runs | Status |
|---|---|---|---|
| ASan + UBSan | `test_syncer.c` + `prop_test.c` | `cd core && make sanitize` | **in CI** — `.github/workflows/ci.yml`, job `core (sanitize)`, `ubuntu-latest` |
| LeakSanitizer | same two suites | Linux only. Explicit pass: `core/test/fuzz/run_fuzz.sh leaks` with `ASAN_OPTIONS=detect_leaks=1` | not a separate CI job; the CI `sanitize` leg runs on Linux, where ASan enables LSan by default |
| libFuzzer (4 harnesses) | `fuzz_merge`, `fuzz_strategies`, `fuzz_callback`, `fuzz_idempotent` | `core/test/fuzz/run_fuzz.sh`, inside a Linux clang container | **manual — not wired into CI** |
| Unit tests | 44 `TEST(...)` registrations in `core/test/test_syncer.c` | `cd core && make` | in CI |
| Property tests | idempotency + "output is valid JSON" over generated pairs, fixed seed | `core/test/prop_test.c`, `cd core && make` | in CI |
| Cross-language differential | ~305 generated pairs, five bindings must produce **byte-identical** output; second pass re-checks idempotency | `test-differential/` | in CI |

Harness details are in [`../core/test/fuzz/README.md`](../core/test/fuzz/README.md).
Each harness packs two documents into one input split on `0x1E`; `fuzz_strategies`
also fuzzes the **options** (strategy, `max_depth`, flag combinations, and four
LWW/FWW/match-key sets including degenerate `,,` lists); `fuzz_callback` targets
the override-callback paths where the engine owns a `free()`, which is what LSan
can check; `fuzz_idempotent` asserts a property, not just memory safety.
Instrumentation is `-fsanitize=fuzzer,address,undefined` with
`-fsanitize-coverage=trace-cmp,trace-div,trace-gep` — `trace-cmp` is decisive,
because nearly every semantic branch is a string compare against a configured
key name.

`core/test/fuzz/crashes/` is currently empty.

### What this does not prove

- **No campaign length is claimed.** `DURATION` defaults to **60 seconds per
  harness** — the README calls that "a CI budget, not a real campaign", and
  recommends `DURATION=3600 JOBS=8 SAVE_CORPUS=1` for a meaningful run. Because
  fuzzing is not in CI, the only campaigns that have run are whatever a
  developer ran locally. **Total fuzzing time to date is not recorded anywhere
  in the repo and is therefore unverified.**
- **macOS `make sanitize` is necessary but not sufficient.** Apple's clang ships
  no LeakSanitizer (`detect_leaks` is unimplemented, not merely off) and no
  libFuzzer runtime (`libclang_rt.fuzzer_osx.a` is absent). A leak passes
  silently on macOS. See `core/test/README.md`.
- **Coverage is not measured.** No line/branch coverage figure is produced or
  asserted for either the suites or the fuzz corpora.
- Sanitizers detect what the inputs reach. A green run means "no error on these
  inputs", not "no error exists".

### Regression discipline

From `core/test/fuzz/README.md`: *"A crash is not fixed until its reproducer is
a deterministic unit test in `../test_syncer.c`."* The corpus is explicitly not
the regression suite. `test_nul_in_key_not_truncated` is the worked example —
found while building the harnesses, fixed in `core/src/syncer.c`, pinned by a
unit test that needs no fuzzer to reproduce.

---

## 2. Untrusted-input handling

The engine is a pure function of its two inputs — no clock, no I/O, no hidden
state ([`MERGE_SEMANTICS.md`](./MERGE_SEMANTICS.md)). The relevant properties
for hostile input:

| Property | Behaviour | Evidence |
|---|---|---|
| Invalid JSON | Returns `NULL`. Never an empty string. Bindings surface it as `null` / `None` / `{:error, _}` / an exception rather than silently yielding `""`. | `core/include/syncer.h:97`; `MERGE_SEMANTICS.md` → "Return values and errors" |
| Allocation failure | Aborts the merge cleanly and returns `NULL` rather than emitting a partial document. Every growable helper carries an `oom` flag instead of assuming `malloc` succeeded. | `core/src/syncer.c:25-27` and the `oom` fields on the path buffer, vector and merge stack (`:34`, `:117`, `:185`) |
| Deep nesting | **No C-stack recursion anywhere** in the engine or in structural comparison — merging is an iterative DFS over a heap stack, so a deeply nested document cannot overflow the C stack. | `core/src/syncer.c:5`, `:160`, `:240`, `:557`; `test_extreme_depth` merges two 1000-level documents (`core/test/test_syncer.c:170-192`) |
| One-sided merge | Passing `NULL` for one input validates and normalizes the side that is present. Fuzzed by `fuzz_strategies`. | `MERGE_SEMANTICS.md` → "Return values and errors" |
| Circular references | Opt-in detection via `detect_circular_refs`, for callers building values programmatically. Not on by default. | `MERGE_SEMANTICS.md` → "Robustness properties" |

### Documented out-of-contract inputs

These are valid JSON but **not supported**, and were found by randomized
testing rather than assumed
([`MERGE_SEMANTICS.md`](./MERGE_SEMANTICS.md#documented-out-of-contract-inputs)):

- **Duplicate keys in one object.** Lookups bind to the first occurrence, so
  results are not guaranteed stable under repeated application.
- **Duplicate identity values in one array** under `MERGE_BY_KEY`. Duplicate
  matches bind to the first element.

They are not memory-safety hazards — the three non-property harnesses fuzz them
hard, with corpus seeds named `oob_*` kept specifically for that — but the
*idempotency* property does not hold on them, which is why `fuzz_idempotent`
filters both shapes out before asserting (using the same int-vs-string identity
normalization the engine uses, so `"id":1` and `"id":"1"` count as duplicates).

`fuzz_idempotent` also treats a `NULL` return from merging two *parseable*
documents as a finding: the engine returns `NULL` only on parse failure or
allocation failure, and that harness injects neither.

---

## 3. Prototype pollution (JavaScript hosts)

`__proto__`, `constructor` and `prototype` are ordinary JSON key names, and a
merge engine that assigns keys onto host objects can be made to write
`Object.prototype`. The C core never constructs host objects — it is text in,
text out — but a JS *host* around it can still be vulnerable, so the e2e
conformance suite tests the host path end to end.

Evidence:
[`opto-sync-e2e/test/conformance/scenarios/12-robustness.mjs`](../../opto-sync-e2e/test/conformance/scenarios/12-robustness.mjs),
two dedicated cases against the Express + Postgres reference server.

### What is actually guaranteed

| Path | `__proto__` reaches storage? | Pollution? |
|---|---|---|
| `POST /doc/:id/sync` | **No** — the request schema rebuilds the object by assignment, which discards a literal `__proto__` key | No |
| `POST /sync/batch` | **Yes** — this path merges `payload` directly without the schema, so the key **is stored as inert jsonb data** | No |

Case 1 (`/sync`) submits `{__proto__: {polluted: "YES"}, constructor: {bad: 1},
prototype: {p: 1}, normal: "ok"}` and asserts:

- the request is accepted (`200`) — these are data, not an attack surface to
  reject;
- `{}.polluted`, `Object.prototype.polluted`, `{}.bad`, `{}.p` are all
  `undefined`, and `Object.getPrototypeOf({}) === Object.prototype`;
- the parsed response document's prototype is the ordinary `Object.prototype`
  and it does not inherit `polluted`;
- `constructor` and `prototype` **survive as ordinary own data keys** holding
  the submitted values — `d.constructor` deep-equals `{bad: 1}` and
  `typeof d.constructor === "object"`, so it did not shadow the real
  constructor function. This is correct: `JSON.parse` creates own properties,
  and such keys are only dangerous when something *assigns* them onto an object;
- `"constructor"` is present in the raw stored jsonb, `"__proto__"` is not.

Case 2 (`/sync/batch`) posts `{"__proto__":{"polluted":"YES"},"k":"v"}` as raw
text and asserts the mutation applied, `"__proto__"` **is** in the stored jsonb,
`Object.prototype` is still clean, and on read-back the key comes home as an
**own** property whose descriptor value is plain data — not as the object's
prototype.

So the guarantee is precisely: *a polluting key name can be stored as inert
data (through the batch path), and reading it back does not pollute any
prototype in the consuming process.* Storage is not prevented on that path, and
the suite documents that difference deliberately rather than hiding it.

The reference server's dev-only fallback merge (`jsDeepMerge`, reached only when
`SYNCER_REQUIRE_NATIVE=0`) additionally skips a `POLLUTING_KEYS` set
(`__proto__`, `constructor`, `prototype`) — because that function *does* assign
keys onto a host object, which is exactly the shape the native path avoids.

**Not verified:** no equivalent scenario exists for the WASM binding's host, or
for a browser consumer of the TypeScript client.

---

## 4. SQL injection in the ORM plugins

The plugins under `plugins/` build SQL. Their tests probe both halves of the
usual failure mode: hostile **identifiers**, and hostile **content**.

Evidence: [`../plugins/typescript/test/`](../plugins/typescript/test/).

| Plugin | Identifier handling | Verified how |
|---|---|---|
| `plugins/typescript/typeorm` | `SAFE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/` validates the JSON column name **and** the id column name, throwing before any SQL is built (`typeorm/index.ts:13,70-75`) | `typeorm.test.ts` → "unsafe identifiers are rejected before reaching SQL": `'doc"; drop table typeorm_docs; --'` rejects with `/unsafe column name/`, `'id; drop table typeorm_docs; --'` with `/unsafe id column name/`; then `information_schema.tables` is queried to prove the table still exists, and the row is asserted untouched |
| `plugins/typescript/kysely` | `sql.ref(jsonColumn)` **quotes** the identifier, so a hostile name becomes an unknown identifier Postgres rejects rather than SQL it executes (`kysely/index.ts:54-60`) | `kysely.test.ts` → "column identifier is quoted, not interpolated (injection attempt is inert)": the call rejects, and the table-still-exists check passes |
| `plugins/typescript/drizzle` | Builds **no SQL at all** — it is a Drizzle `customType` plus a pure string-in/string-out merge helper, so there is no identifier to interpolate | reviewed source (`drizzle/index.ts`); no injection test exists because there is no injection surface |
| `plugins/typescript/prisma` | Uses Prisma's model API (`findUnique` / `updateMany`), not raw SQL; the model and field names are fixed at configuration time and a call on a different model is refused (`prisma/index.ts:66-83`) | content test only (below) |

Content — verified for **typeorm, kysely and prisma**. Each writes the string
`he said "hi"; drop table <table>; -- '\ 100%` plus a nested `O'Brien` through
the merge path and asserts both values round-trip **verbatim** from the jsonb
column, and that the table still exists. That demonstrates the document is
carried as a **bound parameter**, never spliced into SQL text.

`typeorm.test.ts` additionally asserts that invalid incoming JSON throws
(`/was not valid JSON/`) and leaves the row untouched — a malformed payload
cannot write garbage.

### Not verified

- The **Rust** (`diesel`, `sqlx`, `seaorm`), **Go** (`gorm`), **Dart**
  (`drift`) and **BEAM** (`ecto`) plugins have no equivalent
  identifier-injection probe in their test suites. Their query builders are
  parameterizing by construction, but that is an inference from the ORM's
  contract, not a tested assertion in this repo.
- `quoteIdent` in `plugins/typescript/test/harness.ts` is **test scaffolding**,
  not a shipped safety mechanism.

---

## 5. The override-callback trust model

`override_cb` is consulted at **every node where both sides are present** —
objects, arrays (including a root-level array, at path `$`) and scalars —
before the configured strategy descends
([`MERGE_SEMANTICS.md`](./MERGE_SEMANTICS.md#override-callbacks)). It therefore
runs *inside* the merge, on the merging thread, with the engine's invariants
mid-flight.

The ownership contract:

- the callback receives the full JSON path plus both serialized values;
- returning `NULL` declines and leaves the strategy untouched;
- **a returned pointer is freed by the core with `free()`, so it must be
  `malloc`-allocated.** Returning a string literal, a stack buffer, or memory
  from a different allocator is a heap corruption bug in the caller.
- an unparseable return falls back to the default merge rather than dropping
  data.

`fuzz_callback.c` exercises this deliberately: its control byte selects decline,
echo v1, echo v2, return unparseable text, return `""`, return a container, or
alternate — and *"every branch has a `free()` the engine owns — exactly what
LSan can check."*

### Bindings that deliberately omit callbacks

Crossing back into a managed runtime mid-merge is a footgun, so several bindings
do not expose the hook at all — verified in source:

| Binding | Callbacks | Evidence |
|---|---|---|
| C | yes (it is the C API) | `core/include/syncer.h:50` |
| TypeScript (native) | yes | `bindings/typescript/index.ts`, `BaseMergeStrategy.ts` |
| Dart | yes | `bindings/dart/lib/syncer.dart` |
| WASM | yes, with a documented warning that a JS exception must not tear through the wasm frames | `bindings/wasm/index.d.ts:47-49` |
| Rust | **no** — `override_cb: None` is hardcoded | `bindings/rust/src/lib.rs:113` |
| Go | **no** — `cOpts.override_cb = nil`, with a comment stating it is intentionally not exposed pending an explicit opt-in API | `bindings/go/syncer.go:8-12,100` |
| BEAM | **no** — "deliberately **not**" exposed | `bindings/beam/lib/syncer.ex:51-53`; `bindings/beam/native/syncer_nif/src/lib.rs:17` |

If you register a callback, treat it as trusted code running in the middle of a
merge, and keep it allocation-correct and non-throwing.

---

## 6. Supabase / PostgREST stand-in

`opto-sync-e2e/test/supabase/` exercises the REST persistence path against a
**local PostgREST v12.2.3** container rather than a cloud Supabase project.
Supabase's REST API *is* PostgREST, so the wire protocol, auth headers, upsert
semantics and jsonb round trip are the real ones.

### JWT auth IS enforced

The arrangement mirrors a real project: the anon "API key" is an HS256 JWT with
`role: anon` signed by the project JWT secret, sent in **both** `apikey` and
`Authorization: Bearer`. PostgREST logs in as a privilege-less `authenticator`
role and `SET ROLE`s to `anon` per request
(`docker-compose.supabase.yml`, `PGRST_JWT_SECRET` / `PGRST_DB_ANON_ROLE` /
`PGRST_DB_URI`). If the secret and the key drift apart, every request 401s.

Two assertions in `test/supabase/run.mjs` prove the suite is not passing against
a wide-open database:

- an **invalid JWT is rejected with 401** (`run.mjs:212`);
- bare PostgREST **404s on `/rest/v1/...`**, proving `SUPABASE_REST_PREFIX` is
  load-bearing rather than decorative (`run.mjs:199-203`).

### RLS is disabled there — the biggest gap

From `opto-sync-e2e/test/supabase/README.md`: the `anon` role in the stand-in
has plain table `GRANT`s and **no Row Level Security enabled**. A real project's
`anon` role is constrained by RLS policies, so:

> a query that passes locally could return zero rows or 403 in production.

Treat a green Supabase-path suite as evidence about protocol shape and merge
correctness, **not** about authorization.

Also explicitly untested there, per the same README:

- **GoTrue auth** — no sign-up/sign-in, no user JWTs carrying a `sub` claim, no
  refresh-token rotation, no key expiry or rotation handling. One static
  long-lived anon token is used throughout.
- **Realtime** — no websocket subscriptions, no logical-replication change feed.
- **PostgREST version drift** — pinned to `v12.2.3`; Supabase runs its own build
  and may differ in defaults or error bodies.
- **Cloud behaviours** — the API gateway (Kong), rate limits, connection-pooler
  semantics, TLS, project-level `apikey` validation ahead of PostgREST, Storage,
  Edge Functions, and network latency/partition behaviour.
- **Supabase client libraries** — `rust-mash` hand-builds its HTTP requests; no
  `supabase-js` / `postgrest-rs` code path is exercised.

The deterministic anon JWT and the JWT secret are **committed in
`docker-compose.supabase.yml`**. They are local test credentials for a
throwaway container and must never be reused for anything reachable.

---

## 7. Server-side hardening (reference server)

For completeness, since it is the component that faces a network. Verified in
`opto-sync-e2e/servers/node/src/index.ts` and pinned by conformance scenario
`12-robustness`:

| Property | Behaviour |
|---|---|
| Error bodies | JSON, never Express's default HTML stack trace, which leaks server paths |
| Malformed JSON | `400 {error: "Malformed JSON body"}` — the document is left untouched and `version` does not advance |
| Payload limit | `express.json({ limit: "32mb" })`; overflow → `413 {error: "Payload too large"}` |
| Abuse | no `5xx` on malformed/non-object bodies, unknown routes, unsupported methods, empty bodies or missing `content-type` |
| Client-supplied merge policy | the `X-Syncer-Options` header is **not read at all** unless `E2E_ALLOW_OPTION_OVERRIDE=1` |
| `POST /reset` | `403` outside test mode |

Known weaker spots in that server, reported rather than papered over:

- unknown routes fall through to Express's **HTML** default 404 (the scenario
  asserts only the status code);
- `500` bodies echo `err.message` verbatim, which for a database error can
  include SQL text or column names.

See [`opto-sync-e2e/docs/SERVER_GUIDE.md`](../../opto-sync-e2e/docs/SERVER_GUIDE.md)
for the full contract.

---

## 8. Operational hazard: stale compiled cores

Not an attack, but it can silently put an **outdated merge engine** in
production, which has the same shape as a reverted security fix. From
[`COMPATIBILITY.md`](./COMPATIBILITY.md#stale-artifact-hazard):

- **node-gyp** does not rebuild `bindings/typescript/build/Release/syncer.node`
  when `core/src/*.c` changes;
- **Go's build cache** does not fingerprint the core sources that
  `syncer_core.c` `#include`s from outside the package directory.

This was caught for real — a differential run showed TS and Go disagreeing with
C/Dart/Rust purely because their embedded core was older. Mitigations in place:
`test-differential/run_all.sh` force-rebuilds the addon when it is older than
the core sources and builds Go with `-a`; CI never caches `node_modules`,
`build/`, `target/`, and passes `-count=1` with Go caching disabled. **Do not
add a compiled-output cache to CI.**

The options struct is also an ABI contract (`COMPATIBILITY.md` §"The options
struct is an ABI contract"): a mismatched struct mirror in a binding is
undefined behaviour, not a compile error.

---

## 9. What is NOT covered

Stated plainly so nobody infers coverage that does not exist.

| Area | Status |
|---|---|
| Formal security audit | **None.** No third-party review has been performed. |
| Fuzzing of the **bindings** | **None.** Only the C core has libFuzzer harnesses. The TypeScript, Dart, Rust, Go, BEAM and WASM bindings are covered by unit tests and by `test-differential/` — which uses a **seeded generator**, not coverage-guided fuzzing — so binding-layer marshalling (string encoding, lifetime handling, callback trampolines) is not fuzzed. |
| Fuzzing of the **plugins and servers** | **None.** |
| Fuzzing in CI | **Not wired up.** `run_fuzz.sh` is manual and Docker-based. |
| DoS / resource limits | **Not analysed** beyond a payload-size cap in the reference server (32 MB → `413`). There is no bound on merge time, output size, document width, or nesting depth (deep nesting is safe from stack overflow, but not rate-limited); no algorithmic-complexity study of `MERGE_BY_KEY` matching or `UNION` dedup against adversarial inputs; no memory-ceiling enforcement in the core. |
| Cryptography | **Out of scope.** The core performs no hashing, signing, encryption or random generation. The only crypto anywhere near the project is the HS256 JWT verification done by PostgREST in the e2e stand-in, which is PostgREST's code, not this project's. |
| Authentication / authorization | **Out of scope for the core and bindings.** They are pure functions with no notion of a principal. Enforcement belongs to the host application. The e2e Supabase suite verifies JWT auth is *enforced by PostgREST*; it does not verify RLS (see §6). |
| Transport security | Not exercised. Every suite is plaintext HTTP on localhost or a compose network. |
| Supply chain | No dependency-audit, SBOM, or pinned-hash verification step exists in CI. The core itself has no dependencies beyond libc and vendored `yyjson`; the bindings, plugins and e2e servers do have dependency trees. |
| Coverage measurement | No line/branch coverage is produced or gated. |
| Multi-tenant isolation | Not a concept in the engine; a merge sees exactly the two documents it is given. |

---

## 10. Reporting a vulnerability

Please report security issues **privately**, not as a public issue or pull
request.

Open a private security advisory on the GitHub repository
(**Security → Advisories → Report a vulnerability**) for the affected component:

| Component | Repository |
|---|---|
| C core, bindings, ORM plugins | `syncer.c` |
| e2e servers and suites | `opto-sync-e2e` |
| Client libraries | `opto-sync-clients` |

Useful to include: affected component and version (`syncer_version()` /
`/health`'s `coreVersion`), a minimal reproducer — ideally in the
`<json1> 0x1E <json2>` shape the fuzz harnesses accept, so it drops straight
into `run_fuzz.sh repro` — and the impact you believe it has.

There is no published response-time commitment, no coordinated-disclosure
policy document, and no bug bounty. A fix will be considered complete only once
its reproducer exists as a deterministic unit test in `core/test/test_syncer.c`
(for core issues) or as a conformance scenario (for server issues), per the
regression discipline in §1.
