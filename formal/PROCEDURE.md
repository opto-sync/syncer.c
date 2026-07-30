# Formal-methods procedure: reconciliation core

This repository already has two code-level proof boundaries: CBMC includes the production C translation unit, and Kani checks the Rust/C ABI boundary. This procedure makes those proofs discoverable through one machine-readable profile, adds a fast bounded specification gate, and defines how future merge-semantics changes extend the proof inventory.

## Claim boundary

`formal/procedure_model.py` checks decimal-timestamp algebra and the closed-world array-strategy domain over finite inputs. It is not a substitute for CBMC or Kani and does not prove arbitrary JSON reconciliation. The production proof boundary remains:

- `core/formal/cbmc_timestamp_harness.c`, compiled against `core/src/syncer.c`;
- Kani proof harnesses in `bindings/rust`;
- randomized properties, fuzzing, sanitizers, and cross-language differential tests outside the bounded proof domain.

## Required proof layers

| Layer | Purpose | Required command |
|---|---|---|
| bounded specification | fast algebra, manifest, and adapter check | `python3 formal/procedure_model.py` |
| C code proof | comparator and invalid ABI guard over production code | `nix develop --command bash scripts/formal-check.sh c` |
| Rust boundary proof | C discriminants and precondition handling | `cargo kani` in `bindings/rust` |
| refinement evidence | native tests and cross-language byte identity | normal CI and differential suites |

A change is not formally covered merely because the Python model passes. The production harness must include the changed path, and applicable native/differential tests must remain green.

## Change procedure

1. Identify the semantic surface: timestamp ordering, array strategy, object merge, array identity, callback boundary, allocation failure, or ownership/FFI.
2. State the safety property before editing implementation code, including quantification and finite bounds.
3. Put the proof against production code wherever the tool supports that; avoid a second implementation masquerading as a code proof.
4. Update `formal/fm.toml` with invariant id, proof asset, command, timeout, and claim strength.
5. Add a counterexample or regression witness that fails under the previous defect.
6. Run the bounded gate, CBMC, affected Kani proofs, native tests, sanitizers, and applicable differential legs.
7. Verify that no `assume` excludes the bug class the harness claims to prove.

## JSON-lines adapter

`python3 formal/procedure_model.py --json-stdin` supports `compare`, `normalize`, and `strategy_valid`. It provides the portfolio `fmctl` runner a deterministic smoke/replay contract while stronger CBMC and Kani jobs remain repository-native.

## Proof maintenance rules

- Never weaken an assertion, lower an unwind bound, or broaden an assumption solely to restore green CI.
- Treat unwinding assertions as part of the proof.
- Pin verifier versions and actions; record upgrades as proof-environment changes.
- Keep counterexamples visible in CI logs.
- A new public array strategy must update the C enum, every binding, bounded domain, CBMC guard, Kani proof, and differential fixtures together.

## Explicitly out of scope

These proofs do not establish convergence for every configured strategy, absence of every allocation failure in vendored JSON code, host-runtime correctness, or byte identity across untested architectures.
