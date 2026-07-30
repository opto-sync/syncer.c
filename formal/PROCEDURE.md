# Formal-methods change procedure

`syncer.c` already combines CBMC proofs, Kani checks, randomized properties, sanitizers, fuzzing, and cross-language differential tests. This procedure governs how those claims evolve when merge semantics, the C ABI, or a binding changes. Existing proof details remain in [`docs/FORMAL_METHODS.md`](../docs/FORMAL_METHODS.md).

The checked inventory is [`procedure.toml`](procedure.toml).

## Change procedure

1. Identify whether a change affects the merge contract, timestamp ordering, option/ABI validation, allocation/error semantics, a language binding, or cross-runtime canonical output.
2. State the property and trusted boundary before choosing a method. CBMC and Kani prove bounded code properties; property/fuzz tests explore broader inputs; differential tests establish runtime agreement. None alone proves all JSON reconciliation.
3. Update the relevant harness and complementary suites in the same pull request. A change to a production function included by a proof harness must show that the harness still reaches the changed branch.
4. Record tool versions, compile definitions, loop/unwind bounds, object/string bounds, sanitizer settings, corpus hash, source revision, and any assumptions about yyjson or host runtimes.
5. Preserve cross-language semantics. When a host cannot represent a value—such as JavaScript integers beyond 2^53—the limitation must be explicit in the contract and differential oracle rather than silently normalized.
6. Run fast bounded proofs and deterministic corpora on pull requests; keep longer fuzz campaigns and wider symbolic bounds scheduled.

## Claim language

Use only **typechecked/compiled harness**, **randomized exploration**, **bounded exhaustive verification**, **implementation replay**, **differential replay**, or **unbounded proof**. A CBMC result must name the production translation unit, symbolic domain, unwind settings, and assertions checked. A differential result must name every runtime and whether comparison is byte-identical or semantic. Never shorten a bounded comparator proof to “all JSON merges are proved.”

## Counterexamples

Retain the original verifier witness, fuzz input, or differential fixture; minimize it without removing the discrepancy; classify contract, C-core, binding, harness, or host-representation defect; and add it to the smallest permanent corpus that reproduces the problem. Keep raw and minimized artifacts with tool/source provenance. Do not suppress a witness by adding an assumption unless the assumption is part of the public contract and reviewed as such.

## Required review triggers

Formal review is mandatory for changes to timestamp parsing/comparison, merge strategy semantics, traversal/visited-state logic, allocation-failure handling, invalid-option/ABI guards, enum discriminants, FFI string ownership or NUL handling, canonical serialization, binding option mapping, or the differential oracle/corpus.

## Layering rule

Each critical claim should have at least two independent kinds of evidence where practical:

- comparator and ABI predicates: bounded code proof plus native regression/property tests;
- merge convergence/idempotency: algebraic/property tests plus cross-runtime differential replay;
- memory/error safety: sanitizers/fuzzing plus focused bounded assertions;
- FFI compatibility: compile-time/bounded discriminant checks plus per-binding runtime tests.

A new option is incomplete until the C options struct, compatibility documentation, every applicable binding, differential fixtures, and relevant proof/harness inventory are updated together.
