# Formal verification

The reconciliation engine has two code-level proof boundaries in addition to
its randomized, fuzz, sanitizer, and cross-language differential suites.

## Production C core

CBMC compiles `core/formal/cbmc_timestamp_harness.c`, which includes the actual
`core/src/syncer.c` translation unit. It symbolically explores every pair of
two-digit timestamp strings, including leading-zero encodings, and proves:

- numeric ordering and equality agree with the production comparator;
- comparison is antisymmetric;
- bounds, pointers, conversions, division, and signed/unsigned arithmetic are
  safe on the reachable proof paths; and
- every invalid C-ABI array-strategy discriminant is rejected before JSON
  parsing.

The two-character bound is deliberate: it exhausts 10,000 timestamp pairs
while exercising the leading-zero normalization and length-independent numeric
ordering rules. Randomized and fuzz tests cover larger JSON documents and
timestamps.

## Rust FFI binding

Kani proves that Rust's five strategy discriminants remain identical to the C
ABI and that the interior-NUL precondition check is exact for arbitrary bounded
byte arrays. The production wrapper calls that predicate before constructing
any `CString`; native tests then exercise the actual C call and ownership
boundary.

Run the reproducible C proof and native Rust tests:

```bash
nix develop --command bash scripts/formal-check.sh all

cargo install --locked kani-verifier --version 0.67.0
cargo kani setup
(cd bindings/rust && cargo kani)
```

These are bounded code proofs, not a proof of all JSON reconciliation. The
property tests, libFuzzer campaigns, sanitizers, and C/Rust differential corpus
remain required complementary gates.
