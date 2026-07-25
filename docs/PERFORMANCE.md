# Performance

Every number here was measured. They are **observations on one machine**, not
targets or guarantees — re-measure on your own hardware before depending on any
of them.

Measured on: Apple M4 Max (16 cores), macOS 26.5.2 (arm64), Apple clang 21.0.0,
`cc -O2`, core 0.2.1. The committed harness is
[`core/test/stress_test.c`](../core/test/stress_test.c) (a manual harness, not
part of `make`); the tables below also use ad-hoc benchmarks described at the
bottom. Multi-pass figures are the minimum of three timed runs.

## The headline

Merging is fast for ordinary documents — **38 µs** for a 100-element keyed
array, ~26k merges/second single-threaded. But **three separate quadratic terms**
exist, and they are about *counts*, not bytes:

| Quadratic in | Why | Affects |
|---|---|---|
| array element count | `find_by_ident` / `array_contains` scan the base array per incoming element | `MERGE_BY_KEY`, `UNION` |
| array element count | yyjson mutable arrays are circular linked lists, so indexed access is O(i) | `MERGE_BY_INDEX` |
| **object key count** | `yyjson_mut_obj_getn` is a linear key scan; `obj_put` walks the object | **every strategy** |

The third is the one that surprises people: a flat object with 10,000 keys costs
~344 ms to merge regardless of which array strategy is set, because no array is
involved at all. Deep nesting, by contrast, is cheap — a 1,000-level chain
merges in **0.027 ms**.

## Per-strategy scaling (array element count)

Keyed-object arrays of *n* elements on both sides, 50 % identity overlap,
timestamp resolution on. µs per merge:

| Strategy | n=10 | n=100 | n=1,000 | n=5,000 |
|---|---|---|---|---|
| `REPLACE` | 1.5 | 8.6 | 84 | 465 |
| `APPEND` | 1.5 | 10.1 | 88 | 452 |
| `MERGE_BY_INDEX` | 2.6 | 24 | 1,698 | 58,609 |
| `MERGE_BY_KEY` | 1.9 | 44 | 4,074 | 90,424 |
| `UNION` | 4.2 | 260 | 24,535 | 597,169 |

`REPLACE` and `APPEND` are linear in array length: they copy, they never compare
(~0.10–0.12 µs/element flat from n=100 to n=10,000).

**`MERGE_BY_KEY` is quadratic even when both arrays are already in the same
order** — `find_by_ident` restarts at index 0 for every incoming element, so
average scan distance is n/2 regardless of ordering. Measured on the stress
fixture shape, in-order is if anything marginally *slower* than permuted
(390 ms vs 367 ms at n=10,000). All-new ids, where every scan runs to the end of
a growing array, cost ~1.9× the matched case (690 ms at n=10,000).

**`MERGE_BY_INDEX` is quadratic in element count regardless of element size.**
`yyjson_mut_arr_get(arr, i)` walks the list (`yyjson.h`), and
`yyjson_mut_arr_replace` likewise. With single-integer elements — constant
element size — 10× the count costs 123× the time:

| n | `MERGE_BY_INDEX` | `REPLACE` control |
|---|---|---|
| 100 | 0.012 ms | 0.0016 ms |
| 1,000 | 0.764 ms | 0.0116 ms |
| 10,000 | 93.9 ms | 0.119 ms |

**Practical guidance.** Keyed arrays are comfortable into the low thousands: 1,000
elements is ~4 ms, fine per request; 5,000 is 90 ms, not. If a jsonb column holds
more than a few thousand records, promote them to real rows and reconcile per
row. Prefer `MERGE_BY_KEY` over `UNION` whenever elements have an identity key —
it is both cheaper and semantically better. And note `UNION` is **not** cheap on
scalars either: 1,000 duplicate ints cost 10 ms, 10,000 cost ~1 s, and 10,000
disjoint ints cost ~3 s.

## Object key count affects every strategy

Flat object, all keys present on both sides:

| keys | ms/merge |
|---|---|
| 100 | 0.044 |
| 1,000 | 4.03 |
| 10,000 | 343.6 |

Keys present only on the incoming side (no lookup hits) is still quadratic
(310 ms at 10,000). `max_depth` does not help — the root key scan happens before
any depth cut.

This is what the 5 MB stress case actually measures. That fixture is a flat root
object of ~700-byte values, so 5 MB is roughly 7,500 root keys, and throughput
collapses super-linearly with size because key count drives it:

| mixed doc | `REPLACE` | `UNION`+LWW | `MERGE_BY_KEY`+LWW | +`detect_circular_refs` |
|---|---|---|---|---|
| 64 KB | 0.198 ms (632 MB/s) | 0.355 ms | 0.395 ms | 1.202 ms |
| 1 MB | 43.3 ms (46 MB/s) | 46.9 ms | 47.1 ms | 283.5 ms |
| 5 MB | 1,372 ms (7.3 MB/s) | 1,395 ms | 1,406 ms | 7,291 ms |

`REPLACE` — which does no array work whatsoever — costs the same 1.37 s, so the
array strategy is not the driver here.

**`detect_circular_refs` costs 5–6.5×** (283 ms vs 43 ms at 1 MB) because
`visited_contains` linearly scans every pair visited so far. It is off by
default; leave it off unless you build values programmatically.

## Parse vs merge vs serialize

`yyjson` I/O is linear and fast; above ~100 KB essentially all the time is the
merge walk:

| doc | parse ×2 + mut_copy + write | full merge | merge walk |
|---|---|---|---|
| 64 KB | 0.096 ms | 0.202 ms | 0.106 ms (52 %) |
| 1 MB | 1.42 ms | 44.2 ms | 42.8 ms (97 %) |
| 5 MB | 7.12 ms | 1,419 ms | 1,412 ms (99.5 %) |

Small merges are about half fixed I/O, which is why per-merge cost at n=10
(1.5 µs) is dominated by overhead rather than merge work.

## The UNION comparator: two measured improvements

`UNION` dedup changed twice, and both changes were measured against the
prior code (extracted from git and linked against an identical `yyjson.c`, so the
comparator was the only variable):

**1. Structural comparison replaced serialize-and-`strcmp` (0.2.1).** This was a
correctness fix — `jsonb` reorders object keys, which defeated text comparison —
and it also made dedup **2.4–2.7× faster**, because the old path allocated two
serializations per candidate pair:

| Fixture | serialize+strcmp | structural | speedup |
|---|---|---|---|
| 1,000 ints, all duplicates | 24,005 µs | 10,101 µs | 2.38× |
| 1,000 four-key objects, disjoint | 152,909 µs | 56,996 µs | 2.68× |

Per comparison: 47.5 → 19.9 ns (int), 193.0 → 71.9 ns (nested object).

**2. The comparator's scratch stack is now allocated once per scan, not per
comparison.** At n=1,000 that removed ~500k malloc/free pairs per merge, roughly
**halving** `UNION`:

| n | per-comparison alloc | reused stack | speedup |
|---|---|---|---|
| 100 | 528 µs | 260 µs | 2.03× |
| 1,000 | 50,935 µs | 24,535 µs | 2.08× |
| 5,000 | 1,231,973 µs | 597,169 µs | 2.06× |

This was found indirectly: wasm *beat* native by 3.5× on the dedup path, which
only makes sense if the comparator is allocator-bound (emscripten's `dlmalloc`
is cheaper than macOS libmalloc). Output is byte-identical before and after —
verified by the cross-language differential suite.

Dedup cost is insensitive to key order, as the structural design intends
(26.2 ms identical vs 27.4 ms reversed, n=1,000 five-key objects).

## WebAssembly

Committed artifacts in [`bindings/wasm/dist/`](../bindings/wasm/dist/):

| File | Raw | gzip -9 | brotli -q 11 |
|---|---|---|---|
| `syncer-core.wasm` | 147,213 B | 55,899 B | 43,067 B |
| `syncer-core.mjs` (split glue) | 12,417 B | 4,278 B | 3,890 B |
| `syncer-core.single.mjs` (default) | 179,510 B | 64,417 B | 48,941 B |

For comparison, the native shared library is 308,432 B. The full browser client
bundle (client + engine, minified) is ~332 KB raw / ~99 KB gzipped, asserted by
`opto-sync-clients/clients/ts/test/bundle.test.mjs`.

Throughput under Node v22, same inputs, including the wrapper's UTF-8
marshalling in and out of the wasm heap:

| Workload | native | wasm | wasm vs native |
|---|---|---|---|
| 179 B row, `MERGE_BY_KEY`+LWW | 1.38 µs | 2.93 µs | 2.1× slower |
| 100-element keyed array | 37.9 µs | 94.9 µs | 2.5× slower |
| 1,000-element keyed array | 3.39 ms | 3.57 ms | 1.06× slower |
| 64 KB mixed doc, `REPLACE` | 0.20 ms | 0.72 ms | 3.6× slower |
| 5 MB mixed doc, `REPLACE` | 1.38 s | 1.57 s | 1.14× slower |

The penalty is 2–3.6× when parse/copy/write dominates and shrinks to 1.1–1.4×
when the quadratic walk dominates. In a sync path it is generally irrelevant next
to network latency.

## Concurrency

Merging is a pure function with no shared mutable state (the only thread-local is
the legacy callback slot, used solely by `syncer_merge_json`), so merges run
concurrently without coordination. Asserted, not assumed: Go runs 100 goroutines
× 100 merges under `-race` byte-compared to a single-threaded reference; Rust
runs 16 threads × 500 merges plus a legacy/extended path mix; TypeScript runs 8
`worker_threads` × 200 merges plus a nested-callback reentrancy check. A single
merge is single-threaded — parallelism comes from merging different documents at
once.

## Reproducing

```sh
cd core
cc -O2 -Iinclude -Isrc -o /tmp/stress test/stress_test.c src/syncer.c src/yyjson.c
/tmp/stress
```

On this machine that reports 0.357 s for the 10,000-element `MERGE_BY_KEY` case,
1.34 s for the 5 MB document, and 35.3 µs per 100-element merge — which lines up
with the tables above (the n=5,000 row × 4 ≈ 360 ms is exactly what a clean
quadratic predicts for n=10,000).

The other tables came from ad-hoc harnesses that are deliberately not committed —
they have no assertions and would rot as tests. Their parameters: keyed-object
arrays with 50 % identity overlap, `resolve_by_timestamp` on with
`lww_keys="updatedAt,syncedAt"` / `fww_keys="createdAt"`; flat objects of *k*
keys for the object-count table; single-integer elements for the
`MERGE_BY_INDEX` table; and for the comparator comparison, the pre-fix
`array_contains` extracted via `git show 3d7e064c:core/src/syncer.c` linked
against the current `yyjson.c`.
