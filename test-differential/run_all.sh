#!/usr/bin/env bash
# run_all.sh — builds every runner, generates the corpus, runs the
# cross-language differential test (pass 1) and the idempotency test (pass 2).
set -euo pipefail
cd "$(dirname "$0")"

CORE=../core
export SYNCER_LIB_PATH="$PWD/$CORE/build/libsyncer.dylib"

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

# Go runner (replace directive -> ../../bindings/go, cgo compiles the core)
(cd go-runner && go build -o run_go .)
echo "built run_go"

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

node compare.js --corpus corpus.jsonl \
  c=results-c.jsonl ts=results-ts.jsonl dart=results-dart.jsonl \
  rust=results-rust.jsonl go=results-go.jsonl

echo
echo "== [4/4] pass 2: idempotency (re-merge own output with same incoming) =="
for lang in c ts dart rust go; do
  node build_pass2.js corpus.jsonl "results-$lang.jsonl" "corpus2-$lang.jsonl"
done
./run_c                          corpus2-c.jsonl    results2-c.jsonl
node run_ts.js                   corpus2-ts.jsonl   results2-ts.jsonl
dart run run_dart.dart           corpus2-dart.jsonl results2-dart.jsonl
./rust-runner/target/release/run_rust corpus2-rust.jsonl results2-rust.jsonl
./go-runner/run_go               corpus2-go.jsonl   results2-go.jsonl

# (a) per-language idempotency: results2-<lang> must equal results-<lang>
for lang in c ts dart rust go; do
  node compare.js --corpus "corpus2-$lang.jsonl" \
    "pass1-$lang=results-$lang.jsonl" "pass2-$lang=results2-$lang.jsonl"
done
# (b) cross-language agreement on pass 2 as well
node compare.js --corpus corpus2-c.jsonl \
  c=results2-c.jsonl ts=results2-ts.jsonl dart=results2-dart.jsonl \
  rust=results2-rust.jsonl go=results2-go.jsonl

echo
echo "ALL PASSES OK"
