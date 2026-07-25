# `core/test/fuzz` — coverage-guided fuzzing and true leak detection

Everything here runs inside a Linux clang container. That is not a preference:

* macOS clang has **no libFuzzer runtime** (`libclang_rt.fuzzer_osx.a` is not
  shipped), so `-fsanitize=fuzzer` cannot link on the host at all.
* macOS ASan has **no LeakSanitizer**. `detect_leaks=1` is not merely off, it is
  unimplemented — so a leak in the engine would pass `make sanitize` silently.

Linux clang provides both, so `run_fuzz.sh` shells out to a single
`docker run` (never `docker compose`).

## Run it

```bash
cd core/test/fuzz

./run_fuzz.sh                 # default: 60s per harness, then the leak check
DURATION=900 ./run_fuzz.sh    # 15 min per harness
./run_fuzz.sh leaks           # ONLY the LSan pass over test_syncer + prop_test
./run_fuzz.sh fuzz            # ONLY the fuzzing, skip the suite leak check
```

Exit status is non-zero if any harness crashed, any leak was reported, or a
suite failed, so it drops straight into CI.

### Knobs

| Env | Default | Notes |
|---|---|---|
| `DURATION` | `60` | Seconds **per harness**. The default is a CI budget, not a real campaign. |
| `JOBS` | `1` | Parallel libFuzzer workers. `JOBS=8` is the cheapest way to buy coverage. |
| `MAX_LEN` | `4096` | Max input bytes. Raise to explore wide/deep documents, lower for raw exec/s. |
| `IMAGE` | `silkeh/clang:latest` | Any image with clang + compiler-rt works. |
| `SAVE_CORPUS` | `0` | `1` copies the grown corpus back into `corpus_*/` so the next run starts warm. |
| `RSS_LIMIT_MB` | `2560` | libFuzzer memory cap. |
| `HARNESSES` | all four | Space-separated subset. |

A meaningful campaign is `DURATION=3600 JOBS=8 SAVE_CORPUS=1 ./run_fuzz.sh fuzz`
— eight workers per harness for an hour, with the corpus persisted so the next
run continues rather than restarts. Commit the grown corpus only if you want CI
to inherit the coverage; it grows fast, so prefer pruning with
`-merge=1` first (see below).

## The harnesses

All four pack two documents into one fuzzer input, split on a single ASCII
**RS byte `0x1E`** (`FUZZ_SEP` in `fuzz_util.h`) which never appears unescaped
inside JSON text:

```
<json1> 0x1E <json2>
```

No separator means the whole buffer is used for **both** sides — a self-merge,
which is a useful degenerate shape rather than a wasted exec.

| Harness | Control prefix | What it targets |
|---|---|---|
| `fuzz_merge.c` | none | The configuration real clients use: `MERGE_BY_KEY` + `resolve_by_timestamp`, `lww="updatedAt,syncedAt"`, `fww="createdAt"`, `match="id"`. Merges both directions per exec. |
| `fuzz_strategies.c` | 3 bytes | Fuzzes the **options** too: `strategy = b0 % 5`, `max_depth = b1 % 9`, and `b2` selects `detect_circular_refs`, `resolve_by_timestamp`, and one of four LWW / FWW / match key sets (including spacey and degenerate `,,` lists). Also re-merges its own output and exercises the one-sided `NULL` calls. |
| `fuzz_callback.c` | 2 bytes | The override-callback paths and the legacy `syncer_merge_json` API. `b0` picks the callback's behaviour: decline, echo v1, echo v2, return unparseable text, return `""`, return a container, alternate. Every branch has a `free()` the engine owns — exactly what LSan can check. |
| `fuzz_idempotent.c` | 1 byte | A **property**, not just memory safety: asserts `merge(merge(a,b),b) == merge(a,b)` for the four strategies whose contract promises it (APPEND is excluded by design). |

### Why `fuzz_idempotent` filters its input

`syncer.h` documents two input classes as out of contract, and on those
idempotency genuinely is not promised:

1. objects with **duplicate keys** — lookups bind to the first occurrence;
2. arrays where one **identity value appears more than once** — `MERGE_BY_KEY`
   binds duplicate matches to the first element.

The harness rejects both sides before asserting, using the same int-vs-string
identity normalisation the engine uses (`"id":1` and `"id":"1"` count as
duplicates, because the engine treats them as the same identity). Without that
filter the harness would report a steady stream of non-bugs. Out-of-contract
inputs are still fuzzed hard for *memory safety* by the other three harnesses,
and seeds named `oob_*` in the corpora exist specifically to keep them covered.

## Seeds and dictionary

`gen_corpus.py` regenerates all four corpora from one list of document *pairs*:

```bash
python3 gen_corpus.py       # idempotent, safe to re-run
```

Seeds matter more than mutation here. The engine only reaches its semantic
branches when the same key names line up on **both** sides — identity keys for
`MERGE_BY_KEY`, `updatedAt`/`createdAt` for timestamp resolution. Random byte
mutation essentially never invents that alignment, so every seed is a pair that
already lines up: keyed arrays with `id`/`createdAt`/`updatedAt`/`syncedAt`,
nested objects, unicode keys and identities, digit-string / int64 / float / ISO-8601
timestamps, escaped-NUL keys, key-order-swapped duplicates, and the documented
out-of-contract duplicate-key and duplicate-identity shapes. The same pair list
is emitted once per harness with that harness's control-byte prefixes.

`syncer.dict` covers JSON structural tokens and literals, escape sequences, and —
the part that actually pays — the exact option key names (`"updatedAt":`,
`"createdAt":`, `"id":`, `"uuid":`, …) plus realistic timestamp shapes.

## Instrumentation

```
-fsanitize=fuzzer,address,undefined       # primary
-fsanitize=fuzzer,address                 # second variant, LSan unambiguous
-fsanitize-coverage=trace-cmp,trace-div,trace-gep
```

`trace-cmp` is the decisive flag: nearly every semantic branch in the engine is
a string compare against a configured key name, and without comparison tracing
the fuzzer is reduced to guessing those literals byte by byte.

`yyjson.c` is ~23k lines and takes ~35s to instrument, so the core is compiled
to objects **once per sanitizer variant** and linked into every harness;
recompiling the TU per harness would eat a 60s-per-harness budget outright.

The second variant exists so a leak report can never be confused with, or
masked by, a UBSan diagnostic. (Linux ASan enables LSan by default, so the
primary variant also detects leaks — the split is for unambiguous attribution.)

## Reproducing a crash

Crash and leak artifacts land in `crashes/`, named
`<harness>-crash-<sha1>` / `<harness>-leak-…` / `<harness>-timeout-…`.

```bash
./run_fuzz.sh repro crashes/fuzz_merge-crash-0f2a9c...
```

That rebuilds the matching harness under ASan+UBSan inside the container and
replays the single artifact. To minimise first:

```bash
docker run --rm -v "$PWD/../../..":/src -w /src silkeh/clang:latest bash -c '
  mkdir -p /work && cp -r /src/core/{include,src,test} /work/
  clang -g -O1 -fsanitize=fuzzer,address,undefined \
        -fsanitize-coverage=trace-cmp,trace-div,trace-gep \
        -I/work/include -I/work/src -I/work/test/fuzz \
        -o /tmp/h /work/test/fuzz/fuzz_merge.c /work/src/syncer.c /work/src/yyjson.c
  /tmp/h -minimize_crash=1 -runs=100000 \
        -exact_artifact_path=/src/core/test/fuzz/crashes/minimized \
        /src/core/test/fuzz/crashes/<artifact>'
```

To inspect an artifact by eye, remember the `0x1E` split:

```bash
tr '\036' '\n' < crashes/<artifact>     # one document per line
xxd crashes/<artifact> | head           # control-byte prefix, for harnesses that have one
```

**A crash is not fixed until its reproducer is a deterministic unit test in
`../test_syncer.c`.** The corpus is not a regression suite; `test_syncer.c` is.
`test_nul_in_key_not_truncated` is the worked example: found while building
these harnesses, fixed in `core/src/syncer.c`, pinned by a unit test that needs
no fuzzer to run.

## Pruning the corpus

```bash
# inside the container, after a long campaign
/work/bin/fuzz_merge_asan_ubsan -merge=1 /work/corpus_merge_pruned /work/corpus_merge
```

`-merge=1` keeps only the inputs that contribute coverage, which is what you
want before checking a corpus in.
