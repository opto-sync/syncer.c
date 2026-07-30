# Formal-methods procedure: reconciliation core

`syncer.c` combines CBMC proofs over the production C translation unit, Kani
checks of the Rust/C ABI boundary, a fast bounded specification gate,
randomized properties, sanitizers, fuzzing, and cross-language differential
tests. This procedure governs how those claims evolve when merge semantics,
the C ABI, or a binding changes, and makes the proofs discoverable through two
machine-readable profiles:

- [`fm.toml`](fm.toml) — the executable procedure profile: the bounded model
  (`formal/procedure_model.py`), its invariants, commands, and refinement links
  to the production proofs.
- [`procedure.toml`](procedure.toml) — the checked proof-boundary inventory:
  per-machine risk, backend, safety/liveness claims, bounds, and review
  triggers. Existing proof details remain in
  [`docs/FORMAL_METHODS.md`](../docs/FORMAL_METHODS.md).

## Claim boundary

`formal/procedure_model.py` checks decimal-timestamp algebra and the
closed-world array-strategy domain over finite inputs. It is not a substitute
for CBMC or Kani and does not prove arbitrary JSON reconciliation. The
production proof boundary remains:

- `core/formal/cbmc_timestamp_harness.c`, compiled against `core/src/syncer.c`;
- Kani proof harnesses in `bindings/rust`;
- randomized properties, fuzzing, sanitizers, and cross-language differential
  tests outside the bounded proof domain.

## Required proof layers

| Layer | Purpose | Required command |
|---|---|---|
| bounded specification | fast algebra, manifest, and adapter check | `python3 formal/procedure_model.py` |
| C code proof | comparator and invalid ABI guard over production code | `nix develop --command bash scripts/formal-check.sh c` |
| Rust boundary proof | C discriminants and precondition handling | `cargo kani` in `bindings/rust` |
| refinement evidence | native tests and cross-language byte identity | normal CI and differential suites |

A change is not formally covered merely because the Python model passes. The
production harness must include the changed path, and applicable
native/differential tests must remain green.

Each critical claim should have at least two independent kinds of evidence
where practical:

- comparator and ABI predicates: bounded code proof plus native
  regression/property tests;
- merge convergence/idempotency: algebraic/property tests plus cross-runtime
  differential replay;
- memory/error safety: sanitizers/fuzzing plus focused bounded assertions;
- FFI compatibility: compile-time/bounded discriminant checks plus per-binding
  runtime tests.

## Change procedure

1. Identify the semantic surface: merge contract, timestamp
   parsing/ordering, array strategy, object merge, array identity,
   option/ABI validation, callback boundary, allocation/error semantics,
   ownership/FFI, a language binding, or cross-runtime canonical output.
2. State the safety property and trusted boundary before editing
   implementation code, including quantification and finite bounds. CBMC and
   Kani prove bounded code properties; property/fuzz tests explore broader
   inputs; differential tests establish runtime agreement. None alone proves
   all JSON reconciliation.
3. Put the proof against production code wherever the tool supports that;
   avoid a second implementation masquerading as a code proof. A change to a
   production function included by a proof harness must show that the harness
   still reaches the changed branch, updated in the same pull request as the
   complementary suites.
4. Update both profiles together: `formal/fm.toml` with invariant id, proof
   asset, command, timeout, and claim strength; `formal/procedure.toml` with
   the affected machine's bounds, safety list, and review triggers.
5. Record tool versions, compile definitions, loop/unwind bounds,
   object/string bounds, sanitizer settings, corpus hash, source revision, and
   any assumptions about yyjson or host runtimes.
6. Add a counterexample or regression witness that fails under the previous
   defect.
7. Preserve cross-language semantics. When a host cannot represent a value —
   such as JavaScript integers beyond 2^53 — the limitation must be explicit
   in the contract and differential oracle rather than silently normalized.
8. Run the bounded gate, CBMC, affected Kani proofs, native tests,
   sanitizers, and applicable differential legs on pull requests; keep longer
   fuzz campaigns and wider symbolic bounds scheduled.
9. Verify that no `assume` excludes the bug class the harness claims to
   prove.

## Claim language

Use only **typechecked/compiled harness**, **randomized exploration**,
**bounded exhaustive verification**, **implementation replay**, **differential
replay**, or **unbounded proof**. A CBMC result must name the production
translation unit, symbolic domain, unwind settings, and assertions checked. A
differential result must name every runtime and whether comparison is
byte-identical or semantic. Never shorten a bounded comparator proof to "all
JSON merges are proved."

## Counterexamples

Retain the original verifier witness, fuzz input, or differential fixture;
minimize it without removing the discrepancy; classify contract, C-core,
binding, harness, or host-representation defect; and add it to the smallest
permanent corpus that reproduces the problem. Keep raw and minimized artifacts
with tool/source provenance, visible in CI logs. Do not suppress a witness by
adding an assumption unless the assumption is part of the public contract and
reviewed as such.

## Required review triggers

Formal review is mandatory for changes to timestamp parsing/comparison, merge
strategy semantics, traversal/visited-state logic, allocation-failure
handling, invalid-option/ABI guards, enum discriminants, FFI string ownership
or NUL handling, canonical serialization, binding option mapping, or the
differential oracle/corpus.

## JSON-lines adapter

`python3 formal/procedure_model.py --json-stdin` supports `compare`,
`normalize`, and `strategy_valid`. It provides the portfolio `fmctl` runner a
deterministic smoke/replay contract while stronger CBMC and Kani jobs remain
repository-native.

## Proof maintenance rules

- Never weaken an assertion, lower an unwind bound, or broaden an assumption
  solely to restore green CI.
- Treat unwinding assertions as part of the proof.
- Pin verifier versions and actions; record upgrades as proof-environment
  changes.
- A new public array strategy must update the C enum, every binding, bounded
  domain, CBMC guard, Kani proof, and differential fixtures together; a new
  option is incomplete until the C options struct, compatibility
  documentation, every applicable binding, differential fixtures, and the
  relevant proof/harness inventory are updated together.

## Explicitly out of scope

These proofs do not establish convergence for every configured strategy,
absence of every allocation failure in vendored JSON code, host-runtime
correctness, or byte identity across untested architectures.
