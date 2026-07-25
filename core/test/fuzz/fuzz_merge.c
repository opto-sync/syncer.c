/*
 * fuzz_merge.c — libFuzzer harness for syncer_merge_json_ex with the richest
 * realistic option set: MERGE_BY_KEY + CRDT timestamp resolution.
 *
 * This is the configuration real sync clients use, so it is the one worth the
 * most CPU: identity matching, per-element LWW/FWW resolution, nested object
 * frames pushed from array frames, and JSON-path construction all run.
 *
 * Input format: <json1> 0x1E <json2>   (see fuzz_util.h)
 */
#include <stddef.h>
#include <stdint.h>
#include "syncer.h"
#include "fuzz_util.h"

int LLVMFuzzerTestOneInput(const uint8_t* data, size_t size) {
    if (size > FUZZ_MAX_INPUT) return -1;

    fuzz_pair_t p = fz_split2(data, size);
    if (!p.a || !p.b) { fz_pair_free(&p); return 0; }

    syncer_merge_options_t opts = syncer_default_options();
    opts.array_strategy       = SYNCER_ARRAY_MERGE_BY_KEY;
    opts.resolve_by_timestamp = true;
    opts.lww_keys             = "updatedAt,syncedAt";
    opts.fww_keys             = "createdAt";
    opts.array_match_keys     = "id";

    char* r = syncer_merge_json_ex(p.a, p.b, &opts);
    syncer_free(r);

    /* Also exercise the reversed direction in the same exec: cheap, and it
     * doubles the odds of hitting the "existing side is newer" branches. */
    r = syncer_merge_json_ex(p.b, p.a, &opts);
    syncer_free(r);

    fz_pair_free(&p);
    return 0;
}
