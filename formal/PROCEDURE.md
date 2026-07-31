# Formal-methods procedure: reconciliation core

This repository has complementary proof boundaries rather than one universal
proof: CBMC includes the production C translation unit, Kani checks the
Rust/C ABI boundary, the bounded Python model provides a fast replayable
specification gate, and property/fuzz/differential suites explore the wider
reconciliation surface. This procedure governs how those claims evolve when
merge semantics, the C ABI, or a binding changes.

Two machine-readable files serve different purposes and must remain
consistent:

- [`fm.toml`](fm.toml) — the executable procedure profile consumed by the
  bounded procedure and portfolio tooling: the model
  (`formal/procedure_model.py`), its invariants, commands, and refinement
  links to the production proofs.
- [`procedure.toml`](procedure.toml) — the governance inventory that maps
  production semantics, risk, bounds, faults, review triggers, and
  complementary evidence. Existing proof details remain in
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

A green bounded model is evidence about its declared domain. It is not permission to describe every JSON merge, host runtime, architecture, allocation path, or configuration as proved.

## Required proof layers

| Layer | Purpose | Required command or evidence |
|---|---|---|
| bounded specification | fast algebra, manifest, and adapter check | `python3 formal/procedure_model.py` |
| C code proof | comparator and invalid ABI guard over production code | `nix develop --command bash scripts/formal-check.sh c` |
| Rust boundary proof | C discriminants and wrapper preconditions | `cargo kani` in `bindings/rust` |
| merge exploration | convergence, idempotency, corruption, depth, and allocation behavior | native property tests, sanitizers, and fuzz corpora |
| refinement evidence | implementation and runtime agreement | native tests and cross-language differential replay |

A change is not formally covered merely because one layer passes. The production harness must include the changed path, and all applicable native, fuzz, sanitizer, binding, and differential legs must remain green.

## Change procedure

1. Identify the semantic surface: timestamp ordering, option or ABI validation, object merge, array strategy or identity, traversal state, allocation and error behavior, canonical serialization, binding mapping, or FFI ownership.
2. State the safety or liveness property before editing implementation code. Record its quantification, finite bounds, trusted components, excluded states, and intended claim class.
3. Put code proofs against production code wherever the tool supports that. Do not introduce a second implementation and describe agreement with it as a proof of the production implementation.
4. Update both machine-readable views where applicable: `formal/fm.toml` for executable profile metadata and `formal/procedure.toml` for risk, sources, model assets, faults, bounds, and review triggers.
5. Update the relevant harness and at least one complementary evidence layer in the same pull request. A production branch changed under a proof harness must be shown reachable by the harness.
6. Preserve cross-language semantics. Host representation limits, including JavaScript integers beyond 2^53, must be explicit in the contract and oracle rather than silently normalized.
7. Add or retain a counterexample or regression witness that fails under the previous defect.
8. Run the bounded gate, CBMC, affected Kani proofs, native tests, sanitizers, property suites, and applicable differential legs. Longer fuzz campaigns and wider symbolic bounds remain scheduled evidence.
9. Verify that no assumption, unwind reduction, corpus deletion, or oracle relaxation excludes the defect class the claim says it covers.

## Claim language

Use precise result classes:

- **typechecked or compiled harness** — the harness builds, without a completed verification claim;
- **randomized exploration** — generated cases were sampled under named limits;
- **bounded exhaustive verification** — every state in a declared finite domain was checked;
- **implementation replay** — recorded inputs were replayed through one implementation;
- **differential replay** — named runtimes were compared byte-for-byte or under a documented semantic equivalence;
- **unbounded proof** — use only when the method actually establishes the property without a finite-state or unwind bound.

A CBMC result must name the production translation unit, symbolic domain, unwind settings, assumptions, and assertions checked. A differential result must name every runtime, source revision, corpus or witness hash, and the comparison relation. Never shorten a two-digit comparator proof to “all JSON merges are proved.”

## Counterexamples

Retain the original verifier witness, fuzz input, or differential fixture. Minimize it without removing the discrepancy; classify the defect as contract, C core, binding, harness, oracle, or host-representation behavior; and add it to the smallest permanent corpus that reproduces the failure. Keep raw and minimized artifacts with tool and source provenance.

Do not suppress a witness by adding an assumption unless that assumption is part of the public contract and is reviewed as a contract change. A fixed defect must leave behind a regression test or permanent replay fixture.

## Required review triggers

Formal review is mandatory for changes to:

- timestamp parsing, normalization, comparison, or tie handling;
- merge strategy semantics, array identity, object traversal, or visited-state logic;
- allocation-failure, malformed-input, or partial-output behavior;
- invalid-option guards, enum discriminants, public C structs, or ABI signatures;
- FFI string ownership, interior-NUL handling, allocation, release, or panic boundaries;
- canonical serialization, binding option mapping, differential oracles, or tracked corpora;
- verifier versions, compile definitions, symbolic domains, unwind bounds, assumptions, or scheduled proof commands.

A new public option is incomplete until the C options struct, compatibility documentation, every applicable binding, differential fixtures, and the relevant proof inventories change together.

## Layering rule

Each critical claim should have at least two independent kinds of evidence where practical:

- comparator and ABI predicates: bounded code proof plus native regression or property tests;
- merge convergence and idempotency: algebraic/property tests plus cross-runtime differential replay;
- memory and error safety: sanitizers or fuzzing plus focused bounded assertions;
- FFI compatibility: compile-time or bounded discriminant checks plus per-binding runtime tests.

Shared generators and shared oracles are useful, but their common assumptions must be recorded; two tests that depend on the same incorrect oracle are not independent evidence.

## JSON-lines adapter

`python3 formal/procedure_model.py --json-stdin` supports `compare`, `normalize`, and `strategy_valid`. It gives the portfolio `fmctl` runner a deterministic smoke and replay contract while stronger CBMC and Kani jobs remain repository-native.

## Proof maintenance rules

- Never weaken an assertion, lower an unwind bound, broaden an assumption, or delete a witness solely to restore green CI.
- Treat unwinding assertions as part of the proof result.
- Pin verifier versions and actions; record upgrades as proof-environment changes.
- Keep counterexamples visible in CI logs and permanent corpora.
- Record tool versions, compile definitions, loop and object bounds, sanitizer settings, source revisions, and corpus or witness hashes.
- A new public array strategy must update the C enum, every binding, bounded domain, CBMC guard, Kani proof, and differential fixtures together.

## Explicitly out of scope

These proofs do not establish convergence for every configurable strategy, absence of every allocation failure in vendored JSON code, correctness of every host runtime, byte identity across untested architectures, scheduler fairness, or arbitrary-depth termination beyond the declared bounds. Those limitations are part of the result and must not be omitted from release or review language.
