/*
 * fuzz_callback.c — libFuzzer harness for the override-callback paths and the
 * legacy API.
 *
 * The callback contract is the most allocation-sensitive part of the surface:
 * the engine serialises both sides (two mallocs it must free), hands them to
 * user code, then takes ownership of whatever pointer comes back, parses it,
 * and either grafts the result in or falls back to the default merge. Every one
 * of those branches has a free() that a fuzzer + LeakSanitizer can check.
 *
 * Input format:
 *   byte 0 : callback behaviour selector (see cb_ex below)
 *   byte 1 : bit0 = also run the legacy syncer_merge_json() path
 *            bit1 = enable resolve_by_timestamp
 *            bits 2..4 = array strategy
 *   rest   : <json1> 0x1E <json2>
 */
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "syncer.h"
#include "fuzz_util.h"

#define CTRL_BYTES 2

static uint8_t g_behaviour;
static unsigned long g_calls;

static char* fz_strdup(const char* s) {
    if (!s) return NULL;
    size_t n = strlen(s);
    char* d = (char*)malloc(n + 1);
    if (d) memcpy(d, s, n + 1);
    return d;
}

/* Extended (path-aware) callback. Returns heap memory the engine owns. */
static char* cb_ex(const char* json_path, const char* val1, const char* val2) {
    g_calls++;
    switch (g_behaviour % 8) {
        case 0:
            return NULL;                       /* decline -> default merge */
        case 1:
            return fz_strdup(val2);            /* echo incoming */
        case 2:
            return fz_strdup(val1);            /* keep existing */
        case 3:
            return fz_strdup("{not json");     /* unparseable -> fallback path */
        case 4:
            return fz_strdup("");              /* empty -> parse failure */
        case 5: {
            /* Encode the path's LENGTH into the result rather than the path
             * text: it makes stale or truncated path bookkeeping show up as a
             * differing output, without needing to JSON-escape whatever bytes
             * the fuzzer put in the key names. Reading json_path here is also
             * what makes ASan check the path buffer for over-reads. */
            size_t plen = strlen(json_path);
            char* s = (char*)malloc(48);
            if (s) snprintf(s, 48, "{\"plen\":%zu}", plen);
            return s;
        }
        case 6:
            /* Alternate declining and echoing so both branches interleave
             * within a single merge traversal. */
            return (g_calls & 1) ? fz_strdup(val2) : NULL;
        default:
            return fz_strdup("[1,{\"a\":[2,3]},null]"); /* container result */
    }
}

/* Legacy (key-only) callback. */
static char* cb_legacy(const char* key, const char* val1, const char* val2) {
    (void)key;
    g_calls++;
    switch (g_behaviour % 4) {
        case 0:  return NULL;
        case 1:  return fz_strdup(val2);
        case 2:  return fz_strdup(val1);
        default: return fz_strdup("!!!");   /* unparseable */
    }
}

int LLVMFuzzerTestOneInput(const uint8_t* data, size_t size) {
    if (size < CTRL_BYTES + 1) return 0;
    if (size > FUZZ_MAX_INPUT) return -1;

    g_behaviour = data[0];
    const uint8_t b1 = data[1];
    g_calls = 0;

    fuzz_pair_t p = fz_split2(data + CTRL_BYTES, size - CTRL_BYTES);
    if (!p.a || !p.b) { fz_pair_free(&p); return 0; }

    syncer_merge_options_t opts = syncer_default_options();
    opts.override_cb          = cb_ex;
    opts.array_strategy       = (syncer_array_strategy_t)((b1 >> 2) % 5);
    opts.resolve_by_timestamp = (b1 & 0x02) != 0;
    opts.lww_keys             = "updatedAt,syncedAt";
    opts.fww_keys             = "createdAt";
    opts.array_match_keys     = "id";

    syncer_free(syncer_merge_json_ex(p.a, p.b, &opts));

    /* max_depth forces merge_leaf (and therefore the callback) at a shallow
     * boundary, which is a different call site than the object-frame override. */
    opts.max_depth = 1 + (b1 & 0x01);
    syncer_free(syncer_merge_json_ex(p.a, p.b, &opts));

    if (b1 & 0x01) {
        syncer_free(syncer_merge_json(p.a, p.b, cb_legacy));
        syncer_free(syncer_merge_json(p.a, p.b, NULL));
    }

    fz_pair_free(&p);
    return 0;
}
