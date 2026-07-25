/*
 * prop_test.c — Randomized property tests for the syncer merge engine.
 *
 * Properties checked over thousands of generated document pairs:
 *   P1. Output is always valid JSON (round-trips through yyjson).
 *   P2. MERGE_BY_KEY re-applying the same incoming payload is idempotent:
 *       merge(merge(a,b), b) == merge(a,b).
 *   P3. No crash on truncated / mutated inputs (parse failure => NULL, never UB).
 *   P4. Every array strategy terminates and satisfies P1.
 *
 * Deterministic: fixed-seed xorshift PRNG, no time() or rand().
 * Intended to run under ASan/UBSan in CI as well as plain.
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <assert.h>
#include "syncer.h"
#include "yyjson.h"

static uint64_t rng_state = 0x9E3779B97F4A7C15ULL;
static uint64_t rnd(void) {
    uint64_t x = rng_state;
    x ^= x << 13; x ^= x >> 7; x ^= x << 17;
    rng_state = x;
    return x;
}
static uint32_t rnd_below(uint32_t n) { return (uint32_t)(rnd() % n); }

/* ---- random JSON generator ---------------------------------------------- */

typedef struct { char* buf; size_t len; size_t cap; } sb_t;

static void sb_put(sb_t* s, const char* str) {
    size_t l = strlen(str);
    while (s->len + l + 1 > s->cap) {
        s->cap *= 2;
        s->buf = (char*)realloc(s->buf, s->cap);
        assert(s->buf);
    }
    memcpy(s->buf + s->len, str, l);
    s->len += l;
    s->buf[s->len] = '\0';
}

static void gen_value(sb_t* s, int depth);

static void gen_scalar(sb_t* s) {
    char tmp[64];
    switch (rnd_below(5)) {
        case 0: snprintf(tmp, sizeof(tmp), "%u", (unsigned)rnd_below(1000)); break;
        case 1: snprintf(tmp, sizeof(tmp), "\"s%u\"", (unsigned)rnd_below(50)); break;
        case 2: strcpy(tmp, "true"); break;
        case 3: strcpy(tmp, "null"); break;
        default: snprintf(tmp, sizeof(tmp), "%u.5", (unsigned)rnd_below(100)); break;
    }
    sb_put(s, tmp);
}

/* Array of "rows": objects carrying id + updatedAt/createdAt + payload —
   the shape MERGE_BY_KEY is designed for, plus occasional scalars mixed in. */
static void gen_rows_array(sb_t* s, int depth) {
    /* Identity values are unique within one array, per the MERGE_BY_KEY
       contract in syncer.h — mirroring rows keyed by a primary key. */
    uint32_t id_mask = 0;
    sb_put(s, "[");
    uint32_t n = rnd_below(5);
    int emitted = 0;
    for (uint32_t i = 0; i < n; i++) {
        if (rnd_below(6) == 0) {
            if (emitted++) sb_put(s, ",");
            gen_scalar(s);
            continue;
        }
        uint32_t id = rnd_below(6);
        if (id_mask & (1u << id)) continue;
        id_mask |= (1u << id);
        if (emitted++) sb_put(s, ",");
        char tmp[128];
        snprintf(tmp, sizeof(tmp),
                 "{\"id\":%u,\"updatedAt\":%u,\"createdAt\":%u,\"p\":",
                 (unsigned)id, (unsigned)rnd_below(500),
                 (unsigned)rnd_below(500));
        sb_put(s, tmp);
        gen_value(s, depth + 1);
        sb_put(s, "}");
    }
    sb_put(s, "]");
}

static void gen_object(sb_t* s, int depth) {
    /* Unique keys per object: duplicate keys are outside the library's
       documented contract (see syncer.h) — no real serializer emits them. */
    uint32_t mask = 0;
    sb_put(s, "{");
    uint32_t n = 1 + rnd_below(4);
    int emitted = 0;
    for (uint32_t i = 0; i < n; i++) {
        uint32_t k = rnd_below(8);
        if (mask & (1u << k)) continue;
        mask |= (1u << k);
        if (emitted++) sb_put(s, ",");
        char key[16];
        snprintf(key, sizeof(key), "\"k%u\":", (unsigned)k);
        sb_put(s, key);
        gen_value(s, depth + 1);
    }
    sb_put(s, "}");
}

static void gen_value(sb_t* s, int depth) {
    if (depth >= 4) { gen_scalar(s); return; }
    switch (rnd_below(4)) {
        case 0: gen_object(s, depth); break;
        case 1: gen_rows_array(s, depth); break;
        default: gen_scalar(s); break;
    }
}

static char* gen_doc(void) {
    sb_t s;
    s.cap = 512;
    s.len = 0;
    s.buf = (char*)malloc(s.cap);
    assert(s.buf);
    s.buf[0] = '\0';
    gen_object(&s, 0); /* root is always an object, like a DB record */
    return s.buf;
}

/* ---- properties ---------------------------------------------------------- */

static int is_valid_json(const char* s) {
    if (!s) return 0;
    yyjson_doc* d = yyjson_read(s, strlen(s), 0);
    if (!d) return 0;
    yyjson_doc_free(d);
    return 1;
}

int main(void) {
    const int ITER = 3000;
    int checked = 0;

    /* P1 + P2: idempotency of MERGE_BY_KEY with CRDT resolution */
    for (int i = 0; i < ITER; i++) {
        char* a = gen_doc();
        char* b = gen_doc();

        syncer_merge_options_t opts = syncer_default_options();
        opts.array_strategy = SYNCER_ARRAY_MERGE_BY_KEY;
        opts.resolve_by_timestamp = true;
        opts.lww_keys = "updatedAt,syncedAt";
        opts.fww_keys = "createdAt";

        char* once = syncer_merge_json_ex(a, b, &opts);
        assert(once && "merge of two valid docs must not fail");
        assert(is_valid_json(once));

        char* twice = syncer_merge_json_ex(once, b, &opts);
        assert(twice && is_valid_json(twice));
        if (strcmp(once, twice) != 0) {
            fprintf(stderr, "\nIDEMPOTENCY VIOLATION (iter %d)\n  a=%s\n  b=%s\n  once=%s\n  twice=%s\n",
                    i, a, b, once, twice);
            return 1;
        }

        syncer_free(once);
        syncer_free(twice);
        free(a);
        free(b);
        checked++;
    }

    /* P4: every strategy terminates and yields valid JSON */
    for (int i = 0; i < 500; i++) {
        char* a = gen_doc();
        char* b = gen_doc();
        for (int st = 0; st <= SYNCER_ARRAY_MERGE_BY_KEY; st++) {
            syncer_merge_options_t opts = syncer_default_options();
            opts.array_strategy = (syncer_array_strategy_t)st;
            opts.resolve_by_timestamp = (st % 2) == 0;
            char* r = syncer_merge_json_ex(a, b, &opts);
            assert(r && is_valid_json(r));
            syncer_free(r);
        }
        free(a);
        free(b);
    }

    /* P3: truncated / corrupted inputs never crash */
    for (int i = 0; i < 1000; i++) {
        char* a = gen_doc();
        size_t la = strlen(a);
        if (la > 2) a[rnd_below((uint32_t)la)] = (char)("{}[,:\"x"[rnd_below(7)]);
        if (rnd_below(3) == 0 && la > 2) a[la - 1 - rnd_below(2)] = '\0';
        char* b = gen_doc();
        syncer_merge_options_t opts = syncer_default_options();
        opts.array_strategy = SYNCER_ARRAY_MERGE_BY_KEY;
        char* r = syncer_merge_json_ex(a, b, &opts);
        if (r) { assert(is_valid_json(r)); syncer_free(r); }
        free(a);
        free(b);
    }

    printf("prop_test: all properties held over %d idempotency pairs, "
           "500x5 strategy runs, 1000 corruption runs\n", checked);
    return 0;
}
