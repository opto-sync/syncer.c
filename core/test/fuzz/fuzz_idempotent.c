/*
 * fuzz_idempotent.c — coverage-guided PROPERTY harness.
 *
 * The other harnesses only prove the engine doesn't corrupt memory. This one
 * asserts the property sync clients actually depend on:
 *
 *     merge(merge(a, b), b) == merge(a, b)
 *
 * for every array strategy whose contract promises idempotency (all but APPEND,
 * which is deliberately concatenating). It is the coverage-guided generalisation
 * of prop_test.c's P2/P2b, which only ever sees documents from its own template
 * generator.
 *
 * CONTRACT FILTER — syncer.h documents two classes of input as unsupported, and
 * on those idempotency genuinely is not promised. Feeding them in would produce
 * a stream of non-bugs, so both sides are rejected before the property runs:
 *   1. objects with duplicate keys (lookups bind to the first occurrence);
 *   2. arrays where one identity value appears more than once (MERGE_BY_KEY
 *      binds duplicate matches to the first element).
 * Identity comparison mirrors the engine's own ident_values_equal(), including
 * its int-vs-string normalisation, so "id":1 and "id":"1" count as duplicates
 * here exactly as the engine would treat them.
 *
 * Input format:
 *   byte 0 : strategy selector
 *   rest   : <json1> 0x1E <json2>
 */
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "syncer.h"
#include "yyjson.h"
#include "fuzz_util.h"

#define CTRL_BYTES 1

/* Strategies whose contract promises merge(merge(a,b),b) == merge(a,b).
 * APPEND is excluded by design. */
static const syncer_array_strategy_t kIdempotent[4] = {
    SYNCER_ARRAY_REPLACE,
    SYNCER_ARRAY_UNION,
    SYNCER_ARRAY_MERGE_BY_INDEX,
    SYNCER_ARRAY_MERGE_BY_KEY,
};

/* ---- contract filter ----------------------------------------------------- */

/* Identity equality between two immutable values, matching the engine's
 * normalisation of int-vs-string identities. */
static bool ident_eq(yyjson_val* a, yyjson_val* b) {
    if (yyjson_is_int(a) && yyjson_is_int(b)) {
        return yyjson_get_sint(a) == yyjson_get_sint(b);
    }
    if (yyjson_is_str(a) && yyjson_is_str(b)) {
        size_t la = yyjson_get_len(a), lb = yyjson_get_len(b);
        return la == lb && memcmp(yyjson_get_str(a), yyjson_get_str(b), la) == 0;
    }
    char buf[24];
    if (yyjson_is_str(a) && yyjson_is_int(b)) {
        snprintf(buf, sizeof(buf), "%lld", (long long)yyjson_get_sint(b));
        return strcmp(yyjson_get_str(a), buf) == 0;
    }
    if (yyjson_is_str(b) && yyjson_is_int(a)) {
        snprintf(buf, sizeof(buf), "%lld", (long long)yyjson_get_sint(a));
        return strcmp(yyjson_get_str(b), buf) == 0;
    }
    char* wa = yyjson_val_write(a, 0, NULL);
    char* wb = yyjson_val_write(b, 0, NULL);
    bool eq = (wa && wb && strcmp(wa, wb) == 0);
    free(wa);
    free(wb);
    return eq;
}

/* Recursion here is bounded on purpose: yyjson_read with default flags caps
 * nesting well below any plausible stack limit, and the filter runs on already
 * parsed documents. The merge engine itself remains heap-iterative. */
#define FILTER_MAX_DEPTH 512

static bool in_contract(yyjson_val* v, int depth) {
    if (depth > FILTER_MAX_DEPTH) return false;

    if (yyjson_is_obj(v)) {
        /* Duplicate keys? O(n^2) but n is tiny for fuzz-sized documents. */
        size_t n = yyjson_obj_size(v);
        yyjson_obj_iter it;
        yyjson_obj_iter_init(v, &it);
        yyjson_val* k;
        size_t i = 0;
        yyjson_val* keys[64];
        if (n > 64) return false; /* keep the filter cheap */
        while ((k = yyjson_obj_iter_next(&it))) {
            if (i >= 64) return false;  /* never trust the size against the array */
            for (size_t j = 0; j < i; j++) {
                size_t lk = yyjson_get_len(k), lj = yyjson_get_len(keys[j]);
                if (lk == lj &&
                    memcmp(yyjson_get_str(k), yyjson_get_str(keys[j]), lk) == 0) {
                    return false;
                }
            }
            keys[i++] = k;
            if (!in_contract(yyjson_obj_iter_get_val(k), depth + 1)) return false;
        }
        return true;
    }

    if (yyjson_is_arr(v)) {
        /* Reject arrays carrying the same identity twice under the match key
         * "id" — MERGE_BY_KEY binds duplicate matches to the first element, so
         * idempotency is not promised there. Duplicate *whole* elements are
         * fine and stay in scope: UNION dedups them and MERGE_BY_INDEX keeps
         * them, but both are stable under re-application. */
        size_t n = yyjson_arr_size(v);
        if (n > 64) return false;
        yyjson_val* idents[64];
        size_t ni = 0;
        for (size_t i = 0; i < n; i++) {
            yyjson_val* e = yyjson_arr_get(v, i);
            if (!in_contract(e, depth + 1)) return false;
            if (!yyjson_is_obj(e)) continue;
            yyjson_val* id = yyjson_obj_get(e, "id");
            if (!id) continue;
            for (size_t j = 0; j < ni; j++) {
                if (ident_eq(id, idents[j])) return false;
            }
            idents[ni++] = id;
        }
        return true;
    }

    return true;
}

static bool doc_in_contract(const char* json) {
    yyjson_doc* d = yyjson_read(json, strlen(json), 0);
    if (!d) return false; /* unparseable: merge returns NULL, nothing to check */
    bool ok = in_contract(yyjson_doc_get_root(d), 0);
    yyjson_doc_free(d);
    return ok;
}

/* ---- harness -------------------------------------------------------------- */

int LLVMFuzzerTestOneInput(const uint8_t* data, size_t size) {
    if (size < CTRL_BYTES + 1) return 0;
    if (size > FUZZ_MAX_INPUT) return -1;

    fuzz_pair_t p = fz_split2(data + CTRL_BYTES, size - CTRL_BYTES);
    if (!p.a || !p.b) { fz_pair_free(&p); return 0; }

    if (!doc_in_contract(p.a) || !doc_in_contract(p.b)) {
        fz_pair_free(&p);
        return 0;
    }

    syncer_merge_options_t opts = syncer_default_options();
    opts.array_strategy       = kIdempotent[data[0] % 4];
    opts.resolve_by_timestamp = true;
    opts.lww_keys             = "updatedAt,syncedAt";
    opts.fww_keys             = "createdAt";
    opts.array_match_keys     = "id";

    char* once = syncer_merge_json_ex(p.a, p.b, &opts);
    if (!once) {
        /* Both sides parsed, so a NULL result means the engine bailed out —
         * only legitimate on allocation failure, which this harness does not
         * inject. Treat it as a finding. */
        fprintf(stderr, "MERGE RETURNED NULL FOR TWO VALID DOCS\n a=%s\n b=%s\n",
                p.a, p.b);
        abort();
    }

    char* twice = syncer_merge_json_ex(once, p.b, &opts);
    if (!twice) {
        fprintf(stderr, "RE-MERGE RETURNED NULL\n once=%s\n b=%s\n", once, p.b);
        abort();
    }

    if (strcmp(once, twice) != 0) {
        fprintf(stderr,
                "IDEMPOTENCY VIOLATION (strategy %d)\n a=%s\n b=%s\n"
                " once=%s\n twice=%s\n",
                (int)opts.array_strategy, p.a, p.b, once, twice);
        abort();
    }

    syncer_free(once);
    syncer_free(twice);
    fz_pair_free(&p);
    return 0;
}
