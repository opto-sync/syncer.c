#!/usr/bin/env bash
# shellcheck shell=bash
set -euo pipefail

readonly MODE="${1:-all}"

check_c() {
  cbmc core/formal/cbmc_timestamp_harness.c \
    --function main \
    -I core/include \
    --bounds-check \
    --pointer-check \
    --pointer-overflow-check \
    --signed-overflow-check \
    --unsigned-overflow-check \
    --conversion-check \
    --div-by-zero-check \
    --unwind 8 \
    --unwinding-assertions \
    --verbosity 2
  echo "CBMC verified the C core proof obligations."
}

check_rust() {
  (
    cd bindings/rust
    cargo test --locked
  )
}

case "$MODE" in
  c)
    check_c
    ;;
  rust)
    check_rust
    ;;
  all)
    check_c
    check_rust
    ;;
  *)
    echo "usage: $0 {c|rust|all}" >&2
    exit 64
    ;;
esac
