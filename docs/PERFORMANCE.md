# Performance

Every number here was measured, not estimated. They are **observations on one
machine**, not targets or guarantees — re-measure on your own hardware before
depending on any of them.

Measured on: Apple M4 Max, macOS 26.5.2 (arm64), Apple clang 21.0.0, `-O2`,
core 0.2.1. Harnesses: [`core/test/stress_test.c`](../core/test/stress_test.c)
(committed; a manual harness, not part of `make`) and an ad-hoc per-strategy
benchmark whose source is reproduced at the bottom of this file.

## The headline

Merging is fast and CPU-bound for ordinary documents — **38 µs** for a
100-element keyed array, ~26k merges/second single-threaded. Two strategies
have a quadratic term that dominates well before documents get large, and
`UNION` is by far the worse of the two.

## Per-strategy scaling

Keyed-object arrays of *n* elements on both sides, 50 % identity overlap,
timestamp resolution on. µs per merge:

| Strategy | n=10 | n=100 | n=1,000 | n=5,000 | Growth 100→5,000 |
|---|---|---|---|---|---|
| `REPLACE` | 1.5 | 10.5 | 75 | 439 | ~42× (linear) |
| `APPEND` | 1.5 | 10.0 | 93 | 585 | ~59× (linear) |
| `MERGE_BY_INDEX` | 2.6 | 25 | 1,742 | 60,738 | ~2,400× |
| `MERGE_BY_KEY` | 1.9 | 43 | 4,066 | 90,014 | ~2,100× |
| `UNION` | 7.0 | 528 | 50,935 | **1,231,973** | ~2,300× |

`REPLACE` and `APPEND` are linear: they copy, they never compare. The other
three are quadratic in the number of elements:

- **`MERGE_BY_KEY`** — `find_by_ident` scans the base array for each incoming
  element, so identity matching is O(n·m). Matched pairs then deep-merge.
- **`UNION`** — `array_contains` runs a full structural comparison of each
  incoming element against every base element, O(n·m) *comparisons*, each of
  which walks two subtrees.
- **`MERGE_BY_INDEX`** — positionally linear in element count, but each pair is
  deep-merged, so cost tracks total element size rather than count alone.

**Practical guidance.** Keyed arrays are comfortable into the low thousands of
elements: 1,000 elements costs ~4 ms, which is fine per request. At 5,000 it is
90 ms, which is not. If a jsonb column holds more than a few thousand records,
promote them to real rows and reconcile per row instead of merging one giant
array — the engine is not the right tool at that shape.

**Avoid `UNION` on large arrays specifically.** At n=1,000 it is 12× slower than
`MERGE_BY_KEY` and at n=5,000 it is 14× slower, because it compares whole
subtrees rather than a single identity value. If your elements have an identity
key, `MERGE_BY_KEY` is both cheaper and semantically better. `UNION` is intended
for sets of scalars and small arrays.

## UNION dedup and key order

`UNION` compares elements structurally (object keys as an unordered set) rather
than by serialized text, so a `jsonb` round trip that reorders keys does not
defeat dedup. Cost is insensitive to key order, as expected — 1,000 multi-key
objects, 100 % duplicates:

| Incoming key order | µs per merge |
|---|---|
| identical to base | 15,154 |
| reversed | 13,392 |

The difference is within run-to-run noise; the comparison walks the same trees
either way.

The previous implementation compared `strcmp` of two freshly serialized strings,
which allocated two buffers per candidate pair. The current implementation
allocates only a small growable stack of value pairs. **I did not benchmark the
old code** (it is replaced), so this is a structural observation about the
allocation pattern, not a measured speedup — do not quote a ratio.

## Large documents

From `core/test/stress_test.c`:

| Workload | Wall time |
|---|---|
| `MERGE_BY_KEY`, two permuted 10,000-element arrays (~617 KB each, worst-case matching) | 0.363 s |
| ~5 MB deeply-mixed document, LWW + `UNION` (output 5.38 MB) | 1.427 s |
| 1,000 × 100-element `MERGE_BY_KEY` merges | 0.038 s total (38.2 µs each, ~26k/s) |

The 5 MB case is the slowest per byte in the suite, which is consistent with it
combining deep nesting, mixed types, and `UNION`'s containment scans.

Note the 10,000-element case (0.363 s) is *faster* than the per-strategy table's
n=5,000 row (0.090 s × … would extrapolate higher): the stress fixture's
elements are smaller and its permutation makes many matches land early in the
scan. Worst-case matching cost depends on where matches sit in the base array,
not only on n.

## WebAssembly

Committed artifacts in [`bindings/wasm/dist/`](../bindings/wasm/dist/):

| File | Raw | gzip -9 |
|---|---|---|
| `syncer-core.wasm` | 147,213 B | 55,899 B |
| `syncer-core.mjs` (split glue) | 12,417 B | 4,278 B |
| `syncer-core.single.mjs` (self-contained, default) | 179,510 B | 64,417 B |

The full browser client bundle — client plus engine, minified — is ~332 KB raw
and ~99 KB gzipped, asserted by a bundle-size test in
`opto-sync-clients/clients/ts/test/bundle.test.mjs`.

I did not benchmark wasm throughput against native. The wasm suite runs 5,000
merges in a loop to prove there is no leak, not to time them; a like-for-like
comparison would need a harness that is not in the tree. Expect wasm to be
slower than a native addon and to remain irrelevant next to network latency in a
sync path.

## Where the time goes

Not separately profiled. The merge engine parses both inputs with `yyjson`,
walks them, and serializes once; for small documents parse and serialize are a
meaningful share of the total, which is why per-merge cost at n=10 (1.5 µs) is
dominated by fixed overhead rather than merge work. No parse/merge/serialize
breakdown is claimed here because none was measured.

## Concurrency

Merging is a pure function with no shared mutable state (the only thread-local
is the legacy callback slot, used solely by `syncer_merge_json`), so merges run
concurrently without coordination. This is asserted rather than assumed:

- Go: 100 goroutines × 100 merges under `-race`, byte-compared to a
  single-threaded reference (`bindings/go/concurrency_test.go`).
- Rust: 16 threads × 500 merges, plus a test mixing the legacy and extended
  paths (`bindings/rust/tests/concurrency.rs`).
- TypeScript: 8 `worker_threads` × 200 merges, plus a nested-callback
  reentrancy check (`bindings/typescript/test-concurrency.js`).

A single merge is single-threaded; parallelism comes from merging different
documents at once.

## Reproducing

```sh
cd core
cc -O2 -Iinclude -Isrc -o /tmp/stress test/stress_test.c src/syncer.c src/yyjson.c
/tmp/stress
```

The per-strategy table came from an ad-hoc harness that builds keyed-object
arrays of a given size and times `syncer_merge_json_ex` across all five
strategies. It is deliberately not committed — it has no assertions and would
rot as a test. Rebuild it from the table's parameters if you need to re-measure:
50 % identity overlap between the two sides, `resolve_by_timestamp` on with
`lww_keys="updatedAt,syncedAt"` and `fww_keys="createdAt"`, 400/400/20/3
iterations for n=10/100/1,000/5,000.
