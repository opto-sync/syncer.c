#!/usr/bin/env bash
#
# run_fuzz.sh — coverage-guided fuzzing + true leak detection for the
#               opto-sync C core, via a Linux clang container.
#
# WHY DOCKER: macOS clang ships no libFuzzer runtime (libclang_rt.fuzzer_osx.a
# is absent) and macOS ASan has no LeakSanitizer at all. Both exist on Linux
# clang, so everything here runs inside a throwaway container. No compose stack
# is touched — a single `docker run` per invocation.
#
# USAGE (from the host):
#     ./run_fuzz.sh                  # all harnesses, 60s each, then leak check
#     DURATION=900 ./run_fuzz.sh     # a longer campaign
#     HARNESSES=fuzz_merge ./run_fuzz.sh
#     ./run_fuzz.sh leaks            # only the LeakSanitizer pass on the suites
#     ./run_fuzz.sh repro crashes/crash-abc123   # replay one saved artifact
#
# ENV KNOBS
#     DURATION      seconds per harness            (default 60 — CI friendly)
#     JOBS          parallel libFuzzer workers     (default 1)
#     MAX_LEN       max input length in bytes      (default 4096)
#     IMAGE         container image                (default silkeh/clang:latest)
#     SAVE_CORPUS   1 = copy the grown corpus back into the repo (default 0)
#     RSS_LIMIT_MB  libFuzzer RSS cap              (default 2560)
#
# EXIT STATUS: non-zero if any harness crashed, any leak was reported, or a
# suite failed — safe to wire straight into CI.

set -uo pipefail

ALL_HARNESSES="fuzz_merge fuzz_strategies fuzz_callback fuzz_idempotent"

DURATION="${DURATION:-60}"
JOBS="${JOBS:-1}"
MAX_LEN="${MAX_LEN:-4096}"
IMAGE="${IMAGE:-silkeh/clang:latest}"
SAVE_CORPUS="${SAVE_CORPUS:-0}"
RSS_LIMIT_MB="${RSS_LIMIT_MB:-2560}"
HARNESSES="${HARNESSES:-$ALL_HARNESSES}"

MODE="${1:-all}"       # all | fuzz | leaks | repro
REPRO_ARG="${2:-}"

# ===========================================================================
#  HOST SIDE — re-exec this same script inside the container
# ===========================================================================
if [ "${FUZZ_IN_DOCKER:-0}" != "1" ]; then
    FUZZ_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    REPO_ROOT="$(cd "$FUZZ_DIR/../../.." && pwd)"   # .../syncer.c

    echo "=== opto-sync fuzz runner ==="
    echo "  repo    : $REPO_ROOT"
    echo "  image   : $IMAGE"
    echo "  mode    : $MODE"
    echo "  duration: ${DURATION}s per harness   jobs: $JOBS   max_len: $MAX_LEN"
    echo

    exec docker run --rm \
        -v "$REPO_ROOT":/src \
        -w /src \
        -e FUZZ_IN_DOCKER=1 \
        -e DURATION="$DURATION" \
        -e JOBS="$JOBS" \
        -e MAX_LEN="$MAX_LEN" \
        -e SAVE_CORPUS="$SAVE_CORPUS" \
        -e RSS_LIMIT_MB="$RSS_LIMIT_MB" \
        -e HARNESSES="$HARNESSES" \
        "$IMAGE" \
        bash /src/core/test/fuzz/run_fuzz.sh "$MODE" "$REPRO_ARG"
fi

# ===========================================================================
#  CONTAINER SIDE
# ===========================================================================
SRC=/src/core                     # bind-mounted, on the host filesystem
FUZZ_SRC=$SRC/test/fuzz
WORK=/work                        # container-local: bind mounts are slow, and
mkdir -p $WORK                    # libFuzzer writes to its corpus constantly

CORE_SRCS="$WORK/src/syncer.c $WORK/src/yyjson.c"
INCLUDES="-I$WORK/include -I$WORK/src -I$WORK/test/fuzz"

# Copy only what compiles — not the whole repo (node_modules etc.).
cp -r $SRC/include $SRC/src $SRC/test $WORK/ 2>/dev/null
mkdir -p $WORK/bin $WORK/artifacts
mkdir -p $FUZZ_SRC/crashes

FAILED=0

# --- ASan/UBSan runtime options -------------------------------------------
# detect_leaks=1 is the whole point of running on Linux; abort_on_error keeps
# UBSan findings from being merely printed and ignored.
export ASAN_OPTIONS="detect_leaks=1:detect_stack_use_after_return=1:strict_string_checks=1:check_initialization_order=1:detect_invalid_pointer_pairs=1:abort_on_error=0"
export UBSAN_OPTIONS="print_stacktrace=1:halt_on_error=1"
export LSAN_OPTIONS="report_objects=1"

banner() { echo; echo "======================================================================"; echo "  $*"; echo "======================================================================"; }

# ---------------------------------------------------------------------------
#  Build. yyjson.c is ~23k lines and takes ~40s to instrument, so the core is
#  compiled to objects ONCE per sanitizer variant and linked into every
#  harness. Compiling the full TU per harness would dominate a 60s-per-harness
#  CI budget entirely.
#
#  COV = the extra coverage signals worth their instrumentation cost here:
#    trace-cmp  — the decisive one. Nearly every semantic branch in the engine
#                 is a string compare against a configured key name
#                 ("updatedAt", "id"); without comparison tracing the fuzzer is
#                 reduced to guessing those literals byte by byte.
#    trace-div  — the timestamp/number normalisation paths.
#    trace-gep  — array indexing in the by-index / by-key strategies.
# ---------------------------------------------------------------------------
COV="-fsanitize-coverage=trace-cmp,trace-div,trace-gep"
BASE_CFLAGS="-g -O1 -fno-omit-frame-pointer -Wall -Wextra"

build_core() {
    local san="$1" suffix="$2"
    if [ -f "$WORK/bin/yyjson${suffix}.o" ]; then return 0; fi
    echo "  compiling core objects for -fsanitize=${san} (once)"
    clang -c $BASE_CFLAGS -fsanitize="$san" $COV $INCLUDES \
          -o "$WORK/bin/yyjson${suffix}.o" "$WORK/src/yyjson.c" || return 1
    clang -c $BASE_CFLAGS -fsanitize="$san" $COV $INCLUDES \
          -o "$WORK/bin/syncer${suffix}.o" "$WORK/src/syncer.c" || return 1
}

# build_harness <name> <no-link sanitizer spec> <link sanitizer spec> <suffix>
build_harness() {
    local name="$1" nolink="$2" link="$3" suffix="$4"
    build_core "$nolink" "$suffix" || return 1
    echo "  linking ${name}${suffix}  (-fsanitize=${link})"
    clang -c $BASE_CFLAGS -fsanitize="$nolink" $COV $INCLUDES \
          -o "$WORK/bin/${name}${suffix}.o" "$WORK/test/fuzz/${name}.c" || return 1
    clang $BASE_CFLAGS -fsanitize="$link" \
          -o "$WORK/bin/${name}${suffix}" \
          "$WORK/bin/${name}${suffix}.o" \
          "$WORK/bin/syncer${suffix}.o" "$WORK/bin/yyjson${suffix}.o"
}

# ---------------------------------------------------------------------------
#  run_harness <name> <suffix>
# ---------------------------------------------------------------------------
run_harness() {
    local name="$1" suffix="$2" secs="$3"
    local corpus="$WORK/${name/fuzz_/corpus_}"
    local seeds="$FUZZ_SRC/${name/fuzz_/corpus_}"
    local log="$WORK/artifacts/${name}${suffix}.log"

    mkdir -p "$corpus"
    [ -d "$seeds" ] && cp -n "$seeds"/* "$corpus"/ 2>/dev/null

    banner "RUN ${name}${suffix} — ${secs}s  (seeds: $(ls -1 "$corpus" | wc -l))"

    "$WORK/bin/${name}${suffix}" "$corpus" \
        -dict="$WORK/test/fuzz/syncer.dict" \
        -max_total_time="$secs" \
        -max_len="$MAX_LEN" \
        -jobs="$JOBS" -workers="$JOBS" \
        -rss_limit_mb="$RSS_LIMIT_MB" \
        -timeout=25 \
        -print_final_stats=1 \
        -artifact_prefix="$FUZZ_SRC/crashes/${name}-" \
        2>&1 | tee "$log"
    local rc=${PIPESTATUS[0]}

    # Summarise what matters: the DONE line carries cov/ft, the stat:: lines
    # carry execs and exec/s.
    echo
    echo "--- summary ${name}${suffix} ---"
    grep -E '^#[0-9]+[[:space:]]+DONE' "$log" | tail -1
    grep -E '^stat::' "$log"
    if [ "$rc" -ne 0 ]; then
        echo "!!! ${name}${suffix} EXITED $rc — artifact(s) in core/test/fuzz/crashes/"
        ls -l "$FUZZ_SRC/crashes/" 2>/dev/null | tail -5
        FAILED=1
    fi

    if [ "$SAVE_CORPUS" = "1" ]; then
        mkdir -p "$seeds"
        cp -n "$corpus"/* "$seeds"/ 2>/dev/null
    fi
}

# ---------------------------------------------------------------------------
#  MODE: repro — replay a single saved artifact under both sanitizer builds
# ---------------------------------------------------------------------------
if [ "$MODE" = "repro" ]; then
    if [ -z "$REPRO_ARG" ]; then echo "usage: run_fuzz.sh repro <artifact>"; exit 2; fi
    art="$REPRO_ARG"
    [ -f "$art" ] || art="/src/core/test/fuzz/$REPRO_ARG"
    [ -f "$art" ] || { echo "no such artifact: $REPRO_ARG"; exit 2; }
    # The harness name is the artifact prefix: "<harness>-crash-<hash>".
    base="$(basename "$art")"
    name="${base%%-*}"
    case "$name" in fuzz) name="$(echo "$base" | cut -d- -f1,2)";; esac
    banner "REPRO $base  with $name"
    build_harness "$name" "fuzzer-no-link,address,undefined" "fuzzer,address,undefined" "_asan_ubsan" || exit 1
    "$WORK/bin/${name}_asan_ubsan" "$art"
    exit $?
fi

# ---------------------------------------------------------------------------
#  MODE: fuzz / all
# ---------------------------------------------------------------------------
if [ "$MODE" = "all" ] || [ "$MODE" = "fuzz" ]; then
    banner "BUILD harnesses"
    for h in $HARNESSES; do
        build_harness "$h" "fuzzer-no-link,address,undefined" "fuzzer,address,undefined" "_asan_ubsan" || FAILED=1
        # Second variant without UBSan: ASan+LSan alone, so a leak report can
        # never be confused with (or masked by) a UBSan diagnostic.
        build_harness "$h" "fuzzer-no-link,address" "fuzzer,address" "_asan_lsan" || FAILED=1
    done

    for h in $HARNESSES; do
        run_harness "$h" "_asan_ubsan" "$DURATION"
    done

    # Leak-focused pass. Shorter by design: the corpus is already grown by the
    # pass above, and -runs replays it deterministically under LSan rather than
    # spending the budget discovering new coverage a second time.
    for h in $HARNESSES; do
        banner "LEAK PASS ${h} (ASan+LSan, corpus replay + ${DURATION}s)"
        corpus="$WORK/${h/fuzz_/corpus_}"
        log="$WORK/artifacts/${h}_leak.log"
        ASAN_OPTIONS="$ASAN_OPTIONS:detect_leaks=1" \
        "$WORK/bin/${h}_asan_lsan" "$corpus" \
            -dict="$WORK/test/fuzz/syncer.dict" \
            -max_total_time="$DURATION" -max_len="$MAX_LEN" \
            -rss_limit_mb="$RSS_LIMIT_MB" -timeout=25 -print_final_stats=1 \
            -artifact_prefix="$FUZZ_SRC/crashes/${h}-leak-" \
            2>&1 | tee "$log"
        rc=${PIPESTATUS[0]}
        grep -E '^#[0-9]+[[:space:]]+DONE|^stat::|LeakSanitizer' "$log" | tail -12
        [ "$rc" -ne 0 ] && { echo "!!! ${h} leak pass EXITED $rc"; FAILED=1; }
    done
fi

# ---------------------------------------------------------------------------
#  MODE: leaks / all — the existing suites under real LeakSanitizer
# ---------------------------------------------------------------------------
if [ "$MODE" = "all" ] || [ "$MODE" = "leaks" ]; then
    banner "LEAK CHECK — existing suites under Linux ASan+UBSan+LSan"
    echo "ASAN_OPTIONS=$ASAN_OPTIONS"
    echo

    for suite in test_syncer prop_test; do
        echo "--- building $suite (ASan+UBSan+LSan) ---"
        clang $BASE_CFLAGS -fsanitize=address,undefined \
              -I$WORK/include -I$WORK/src \
              -o "$WORK/bin/${suite}_lsan" \
              "$WORK/test/${suite}.c" $CORE_SRCS || { FAILED=1; continue; }
        echo "--- running $suite ---"
        if "$WORK/bin/${suite}_lsan"; then
            echo "[OK] $suite: no leaks, no sanitizer findings"
        else
            echo "!!! $suite FAILED (exit $?) — see output above"
            FAILED=1
        fi
        echo
    done
fi

banner "RESULT: $([ $FAILED -eq 0 ] && echo CLEAN || echo FINDINGS PRESENT)"
exit $FAILED
