/*
 * syncer_wasm.c — WebAssembly binding shim for syncer.c.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The natural way to call syncer_merge_json_ex() from JS would be for JS to
 * lay out a syncer_merge_options_t in the wasm heap and pass a pointer. That
 * is a silent-corruption hazard: the struct mixes pointers (4 bytes under
 * wasm32), an enum, a uint32_t and two bools, so its field offsets and tail
 * padding are decided by the compiler, and the struct has already grown once
 * (array_match_keys arrived in core v0.2.0). A JS-side layout that drifts by
 * one field does not crash — it feeds the core a garbage pointer for
 * lww_keys and merges wrongly.
 *
 * So JS never sees the struct. It calls a flat-argument entry point and this
 * file builds the struct in C, starting from syncer_default_options() so that
 * every field (including any field added in a future core release) is
 * initialized by the core's own header.
 *
 * NULL vs "" IS LOAD-BEARING
 * --------------------------
 * The core reads a NULL lww_keys as "use the built-in default (updatedAt)"
 * and a NULL array_match_keys as "id", while an empty string means "no keys
 * at all". The pointers are therefore passed straight through: the JS wrapper
 * sends 0 for an absent option and a pointer to "" for an explicit empty
 * string, exactly as the Node binding distinguishes `undefined` from `''`.
 */

#include <stdlib.h>
#include <malloc.h>

#include <emscripten/emscripten.h>

#include "syncer.h"

/**
 * Flat-argument merge with an optional override callback.
 *
 * @param strategy         syncer_array_strategy_t as an int (0..4). The JS
 *                         wrapper validates it and the C core rejects any
 *                         out-of-range value as a defense in depth.
 * @param max_depth        0 = unlimited.
 * @param detect_circular  0/1.
 * @param resolve_ts       0/1.
 * @param lww/fww/match    Comma-separated key lists, or NULL to leave the
 *                         core's own default in place. NOT the same as "".
 * @param cb               Function pointer into the wasm table (from
 *                         addFunction), or NULL for the default merge.
 * @return malloc'd JSON string for JS to read and then pass to syncer_free(),
 *         or NULL on parse error.
 */
EMSCRIPTEN_KEEPALIVE
char* syncer_merge_flat_cb(const char* j1,
                           const char* j2,
                           int strategy,
                           unsigned max_depth,
                           int detect_circular,
                           int resolve_ts,
                           const char* lww,
                           const char* fww,
                           const char* match,
                           syncer_merge_override_cb_ex cb)
{
    /* A null input string would be a wrapper bug; report it as a parse error
       rather than letting the core dereference it. */
    if (!j1 || !j2) return NULL;

    /* Never construct this struct field-by-field: let the core's own header
       initialize every member, then override only what the caller asked for. */
    syncer_merge_options_t opts = syncer_default_options();
    opts.array_strategy       = (syncer_array_strategy_t)strategy;
    opts.max_depth            = (uint32_t)max_depth;
    opts.detect_circular_refs = detect_circular ? true : false;
    opts.resolve_by_timestamp = resolve_ts ? true : false;
    opts.lww_keys             = lww;
    opts.fww_keys             = fww;
    opts.array_match_keys     = match;
    opts.override_cb          = cb;

    return syncer_merge_json_ex(j1, j2, &opts);
}

/**
 * Flat-argument merge without a callback — the common path.
 */
EMSCRIPTEN_KEEPALIVE
char* syncer_merge_flat(const char* j1,
                       const char* j2,
                       int strategy,
                       unsigned max_depth,
                       int detect_circular,
                       int resolve_ts,
                       const char* lww,
                       const char* fww,
                       const char* match)
{
    return syncer_merge_flat_cb(j1, j2, strategy, max_depth, detect_circular,
                               resolve_ts, lww, fww, match, NULL);
}

/**
 * Bytes currently handed out by malloc and not yet freed.
 *
 * Exists so the test suite can prove the binding is leak-free: run thousands
 * of merges and assert this returns to its pre-loop value. A JS-visible byte
 * count is the only way to see a leak inside the wasm heap — the wasm memory
 * itself never shrinks, so watching total heap size can only catch a leak
 * large enough to force growth.
 */
EMSCRIPTEN_KEEPALIVE
unsigned syncer_wasm_alloc_bytes(void)
{
    struct mallinfo mi = mallinfo();
    return (unsigned)mi.uordblks;
}
