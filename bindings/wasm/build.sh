#!/usr/bin/env bash
#
# Build the syncer.c WebAssembly binding.
#
# emcc is not expected to be installed locally: the build runs inside the
# official emscripten/emsdk image so that anyone with Docker reproduces the
# committed artifacts bit-for-bit-ish (same image tag => same output).
#
#   ./build.sh              # build with the pinned image
#   EMSDK_IMAGE=emscripten/emsdk:latest ./build.sh
#
# Outputs (committed to git — browser consumers must not need emscripten):
#   dist/syncer-core.single.mjs   self-contained ES module (wasm inlined)
#   dist/syncer-core.mjs          ES module loader for the split build
#   dist/syncer-core.wasm         wasm binary for the split build
#
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# bindings/wasm -> bindings -> syncer.c -> repo root
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"
REL_DIR="${HERE#"$REPO_ROOT"/}"

# Pinned so the committed artifacts are reproducible. Bump deliberately.
EMSDK_IMAGE="${EMSDK_IMAGE:-emscripten/emsdk:6.0.4}"

# ---------------------------------------------------------------------------
# Sources: the frozen core plus this binding's shim. The core is compiled from
# its own tree; nothing here modifies it.
# ---------------------------------------------------------------------------
SOURCES=(
  src/syncer_wasm.c
  ../../core/src/syncer.c
  ../../core/src/yyjson.c
)

# Only these C symbols are reachable from JS. syncer_merge_json_ex itself is
# deliberately NOT exported: JS must go through the flat shim so it never has
# to know the options struct layout.
EXPORTED_FUNCTIONS='_syncer_merge_flat,_syncer_merge_flat_cb,_syncer_free,_syncer_version,_syncer_wasm_alloc_bytes,_malloc,_free'

# String marshalling + the function-table helpers used for overrideCb.
EXPORTED_RUNTIME_METHODS='ccall,cwrap,stringToUTF8,UTF8ToString,lengthBytesUTF8,addFunction,removeFunction,HEAPU8'

COMMON_FLAGS=(
  -O3
  -flto
  --no-entry
  -I../../core/include
  -I../../core/src
  -sMODULARIZE=1
  -sEXPORT_ES6=1
  -sEXPORT_NAME=createSyncerModule
  # web,worker only: the glue must never reference require()/fs/path, or
  # bundlers targeting the browser pull in node polyfills (or just break).
  -sENVIRONMENT=web,worker
  -sFILESYSTEM=0
  -sALLOW_MEMORY_GROWTH=1
  # addFunction() needs to append to the indirect function table.
  -sALLOW_TABLE_GROWTH=1
  -sINCOMING_MODULE_JS_API=wasmBinary,locateFile,instantiateWasm,print,printErr
  -sEXPORTED_FUNCTIONS="$EXPORTED_FUNCTIONS"
  -sEXPORTED_RUNTIME_METHODS="$EXPORTED_RUNTIME_METHODS"
  -sMALLOC=dlmalloc
  -sSTRICT=1
  -sASSERTIONS=0
)

run_emcc() {
  docker run --rm \
    -u "$(id -u):$(id -g)" \
    -e EM_CACHE=/tmp/emcache \
    -e HOME=/tmp \
    -v "$REPO_ROOT":/src \
    -w "/src/$REL_DIR" \
    "$EMSDK_IMAGE" \
    emcc "$@"
}

mkdir -p "$HERE/dist"

echo "==> [1/2] split build  -> dist/syncer-core.mjs + dist/syncer-core.wasm"
run_emcc "${SOURCES[@]}" "${COMMON_FLAGS[@]}" -o dist/syncer-core.mjs

echo "==> [2/2] single-file build -> dist/syncer-core.single.mjs"
run_emcc "${SOURCES[@]}" "${COMMON_FLAGS[@]}" -sSINGLE_FILE=1 -o dist/syncer-core.single.mjs

echo
echo "==> artifact sizes"
( cd "$HERE" && ls -l dist/ | awk 'NR>1 {printf "    %-28s %8d bytes\n", $9, $5}' )
echo
echo "==> gzipped"
for f in "$HERE"/dist/*; do
  printf '    %-28s %8d bytes\n' "$(basename "$f").gz" "$(gzip -9 -c "$f" | wc -c | tr -d ' ')"
done
