# `core/test` — how the merge engine is verified

Four layers, cheapest first. Each catches a class the layer above cannot.

| Layer | File | What it proves | Runs where |
|---|---|---|---|
| Unit | `test_syncer.c` | Named behaviours: every strategy, CRDT resolution, callbacks, contract edges | `make` |
| Property | `prop_test.c` | Idempotency + "output is valid JSON" over thousands of generated pairs, fixed seed | `make` |
| Sanitizers | both of the above | No memory errors, no undefined behaviour | `make sanitize` (macOS: **no leak detection**), `fuzz/run_fuzz.sh leaks` (Linux: real LSan) |
| Fuzzing | `fuzz/` | Coverage-guided exploration of inputs *and* option combinations | `fuzz/run_fuzz.sh` (Docker) |

## Quick commands

```bash
cd core

make                 # build + run test_syncer (the unit suite) and prop_test
make sanitize        # rebuild both under ASan+UBSan and run them
make clean

# Coverage-guided fuzzing + TRUE leak detection (needs Docker):
cd test/fuzz && ./run_fuzz.sh
```

## Why the sanitizer story needs Docker

`make sanitize` on macOS gives ASan + UBSan but **not** LeakSanitizer — Apple's
clang ships no LSan, so `detect_leaks` is silently unavailable and a leaked
allocation passes unnoticed. macOS clang also ships no libFuzzer runtime
(`libclang_rt.fuzzer_osx.a` is absent), so `-fsanitize=fuzzer` cannot link.

Linux clang has both. `test/fuzz/run_fuzz.sh` runs everything inside a
throwaway `docker run` against a Linux clang image, which is the only place the
following have ever actually executed:

* coverage-guided fuzzing of the merge engine,
* `ASAN_OPTIONS=detect_leaks=1` over `test_syncer` and `prop_test`.

Treat a green `make sanitize` on macOS as necessary but not sufficient; the
Docker run is what closes the gap. See `fuzz/README.md` for the fuzzing details,
longer campaigns, and crash reproduction.

## Other files in this directory

* `quick_test.c`, `stress_test.c` — ad-hoc drivers, not wired into `make`.
  Compile them the same way as `test_syncer.c` if you need them:
  `cc -Wall -O2 -Iinclude -Isrc -o test/stress_test test/stress_test.c src/*.c`
* `fuzz/` — libFuzzer harnesses, seed corpora, dictionary, runner. Owns its own
  README.

## Adding a test

Unit test: add a `static void test_x(void)` to `test_syncer.c` and a matching
`TEST(test_x);` line in `main`. The count in `=== Results: N/N passed ===` is
derived, not hardcoded.

If a fuzz campaign finds a crash, the fix is not complete until the reproducer
is also a deterministic unit test — the corpus is not checked in as a
regression suite, `test_syncer.c` is.
