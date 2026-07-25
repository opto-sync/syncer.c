/*
 * fuzz_strategies.c — libFuzzer harness that fuzzes the OPTIONS as well as the
 * documents, so every array strategy and every option combination gets
 * explored by the same coverage-guided campaign.
 *
 * Input format:
 *   byte 0 : array_strategy  = b0 % 5      (REPLACE..MERGE_BY_KEY)
 *   byte 1 : max_depth       = b1 % 9      (0 = unlimited)
 *   byte 2 : flag/keyset bits (see below)
 *   rest   : <json1> 0x1E <json2>          (see fuzz_util.h)
 *
 * Keeping the control bytes at a fixed prefix means libFuzzer's byte-level
 * mutations flip strategies cheaply while the corpus entry's document body is
 * preserved — much more productive than randomising options per exec.
 */
#include <stddef.h>
#include <stdint.h>
#include "syncer.h"
#include "fuzz_util.h"

#define CTRL_BYTES 3

static const char* const kLwwSets[4] = {
    NULL,                       /* engine default ("updatedAt") */
    "updatedAt",
    "updatedAt,syncedAt",
    "updatedAt, syncedAt , rev" /* spaces + 3 keys: exercises the trimmer */
};

static const char* const kFwwSets[4] = {
    NULL,
    "createdAt",
    "createdAt,firstSeenAt",
    ",,"                        /* degenerate: all-empty segments */
};

static const char* const kMatchSets[4] = {
    NULL,                       /* engine default ("id") */
    "id",
    "uuid,id",
    " id , key "                /* spaces around identity keys */
};

int LLVMFuzzerTestOneInput(const uint8_t* data, size_t size) {
    if (size < CTRL_BYTES + 1) return 0;
    if (size > FUZZ_MAX_INPUT) return -1;

    const uint8_t b0 = data[0], b1 = data[1], b2 = data[2];

    fuzz_pair_t p = fz_split2(data + CTRL_BYTES, size - CTRL_BYTES);
    if (!p.a || !p.b) { fz_pair_free(&p); return 0; }

    syncer_merge_options_t opts = syncer_default_options();
    opts.array_strategy       = (syncer_array_strategy_t)(b0 % 5);
    opts.max_depth            = (uint32_t)(b1 % 9);
    opts.detect_circular_refs = (b2 & 0x01) != 0;
    opts.resolve_by_timestamp = (b2 & 0x02) != 0;
    opts.lww_keys             = kLwwSets[(b2 >> 2) & 0x03];
    opts.fww_keys             = kFwwSets[(b2 >> 4) & 0x03];
    opts.array_match_keys     = kMatchSets[(b2 >> 6) & 0x03];

    char* r = syncer_merge_json_ex(p.a, p.b, &opts);

    /* Feed the merge output back in as the base document. Re-merging a
     * previously merged doc is what a real replica does on the next sync, and
     * it reaches states that a single merge of two fuzzer strings cannot. */
    if (r) {
        char* r2 = syncer_merge_json_ex(r, p.b, &opts);
        syncer_free(r2);
        syncer_free(r);
    }

    /* One-sided calls: NULL handling in the public API. */
    syncer_free(syncer_merge_json_ex(p.a, NULL, &opts));
    syncer_free(syncer_merge_json_ex(NULL, p.b, &opts));

    fz_pair_free(&p);
    return 0;
}
