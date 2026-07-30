#!/usr/bin/env bash
# run_all.sh — builds every runner, generates the corpus, runs the
# cross-language differential test (pass 1) and the idempotency test (pass 2).
set -euo pipefail
cd "$(dirname "$0")"

CORE=../core

# Shared-library name is platform-dependent, and an already-exported
# SYNCER_LIB_PATH (as CI sets) must win rather than being clobbered.
if [ -z "${SYNCER_LIB_PATH:-}" ]; then
  case "$(uname -s)" in
    Darwin) CORE_LIB=libsyncer.dylib ;;
    MINGW*|MSYS*|CYGWIN*) CORE_LIB=syncer.dll ;;
    *) CORE_LIB=libsyncer.so ;;
  esac
  export SYNCER_LIB_PATH="$PWD/$CORE/build/$CORE_LIB"
fi

echo "== [0/4] toolchain versions =="
node --version
dart --version 2>&1 | head -1
go version
cargo --version

echo
echo "== [1/4] build runners =="
# C reference runner (compiles the core sources directly)
cc -O2 -I"$CORE/include" -I"$CORE/src" -o run_c run_c.c "$CORE/src/syncer.c" "$CORE/src/yyjson.c"
echo "built run_c"

# TypeScript: addon must exist AND be newer than the core sources it embeds
# (node-gyp does not rebuild when ../core/src changes).
TS_NODE=../bindings/typescript/build/Release/syncer.node
if [ ! -f "$TS_NODE" ] \
   || [ "$CORE/src/syncer.c" -nt "$TS_NODE" ] \
   || [ "$CORE/src/yyjson.c" -nt "$TS_NODE" ] \
   || [ ../bindings/typescript/src/addon.cc -nt "$TS_NODE" ]; then
  (cd ../bindings/typescript && npm run build >/dev/null)
  echo "typescript addon rebuilt (was stale/missing)"
else
  echo "typescript addon ok"
fi

# Dart: resolve the path dependency on ../bindings/dart
if [ ! -f .dart_tool/package_config.json ]; then
  dart pub get >/dev/null
fi
echo "dart deps ok"

# Rust bin crate (path dep on ../../bindings/rust, statically links the core)
(cd rust-runner && cargo build --release --quiet)
echo "built run_rust"

# Go runner (replace directive -> ../../bindings/go, cgo compiles the core).
# -a forces a full rebuild: Go's build cache does not track the core .c files
# that syncer_core.c #includes from outside the package directory.
(cd go-runner && go build -a -o run_go .)
echo "built run_go"

# Rust-NATIVE runner (the standalone reimplementation at ../../../syncer.rs —
# no C code; must still be byte-identical). Sibling checkout, so optional:
# absent in a lone syncer.c CI clone, override with SYNCER_RS_DIR.
RUST_NATIVE_DIR="${SYNCER_RS_DIR:-../../syncer.rs}"
if [ -f "$RUST_NATIVE_DIR/Cargo.toml" ]; then
  (cd "$RUST_NATIVE_DIR" && cargo build --release --quiet --example jsonl_runner)
  RUST_NATIVE="$RUST_NATIVE_DIR/target/release/examples/jsonl_runner"
  echo "built run_rustnative (standalone syncer.rs)"
else
  RUST_NATIVE=""
  echo "skipping rust-native: $RUST_NATIVE_DIR not found (set SYNCER_RS_DIR)"
fi

echo
echo "== [2/4] generate corpus =="
node gen_corpus.js

echo
echo "== [3/4] pass 1: differential merge =="
./run_c                          corpus.jsonl results-c.jsonl
node run_ts.js                   corpus.jsonl results-ts.jsonl
dart run run_dart.dart           corpus.jsonl results-dart.jsonl
./rust-runner/target/release/run_rust corpus.jsonl results-rust.jsonl
./go-runner/run_go               corpus.jsonl results-go.jsonl
if [ -n "$RUST_NATIVE" ]; then
  "$RUST_NATIVE"                 corpus.jsonl results-rustnative.jsonl
fi

node compare.js --corpus corpus.jsonl \
  c=results-c.jsonl ts=results-ts.jsonl dart=results-dart.jsonl \
  rust=results-rust.jsonl go=results-go.jsonl \
  ${RUST_NATIVE:+rustnative=results-rustnative.jsonl}

echo
echo "== [4/4] pass 2: idempotency (re-merge own output with same incoming) =="
LANGS="c ts dart rust go"
if [ -n "$RUST_NATIVE" ]; then
  LANGS="$LANGS rustnative"
fi
for lang in $LANGS; do
  node build_pass2.js corpus.jsonl "results-$lang.jsonl" "corpus2-$lang.jsonl"
done
./run_c                          corpus2-c.jsonl    results2-c.jsonl
node run_ts.js                   corpus2-ts.jsonl   results2-ts.jsonl
dart run run_dart.dart           corpus2-dart.jsonl results2-dart.jsonl
./rust-runner/target/release/run_rust corpus2-rust.jsonl results2-rust.jsonl
./go-runner/run_go               corpus2-go.jsonl   results2-go.jsonl
if [ -n "$RUST_NATIVE" ]; then
  "$RUST_NATIVE"                 corpus2-rustnative.jsonl results2-rustnative.jsonl
fi

# (a) per-language idempotency: results2-<lang> must equal results-<lang>
for lang in $LANGS; do
  node compare.js --corpus "corpus2-$lang.jsonl" \
    "pass1-$lang=results-$lang.jsonl" "pass2-$lang=results2-$lang.jsonl"
done
# (b) cross-language agreement on pass 2 as well
node compare.js --corpus corpus2-c.jsonl \
  c=results2-c.jsonl ts=results2-ts.jsonl dart=results2-dart.jsonl \
  rust=results2-rust.jsonl go=results2-go.jsonl \
  ${RUST_NATIVE:+rustnative=results2-rustnative.jsonl}

if [ -n "$RUST_NATIVE" ]; then
  echo
  echo "== [5/5] pass 3: randomized C vs rust-native fuzz =="
  # Random documents x random option sets (all 5 strategies, pointer
  # selectors, max_depth), byte-identical + pass-2 fixed point required.
  FUZZ_ITERS="${FUZZ_ITERS:-20000}"
  (cd rustnative-fuzz && cargo build --release --quiet)
  ./rustnative-fuzz/target/release/rustnative-fuzz "$FUZZ_ITERS"
fi

echo
echo "ALL PASSES OK"
