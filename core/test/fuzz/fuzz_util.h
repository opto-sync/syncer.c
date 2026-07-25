/*
 * fuzz_util.h — shared helpers for the opto-sync libFuzzer harnesses.
 *
 * The public API takes NUL-terminated `const char*`, so every harness has to
 * carve the raw fuzzer buffer into C strings. Two documents are packed into one
 * input separated by a single ASCII RS byte (0x1E, `FUZZ_SEP`), which never
 * appears unescaped inside valid JSON text and is therefore trivially learnable
 * by the mutator while keeping seed files (mostly) human-readable.
 *
 *   <json1> 0x1E <json2>
 *
 * If no separator is present the whole buffer is used for BOTH sides, which is
 * a useful degenerate case in its own right (self-merge / idempotency shape).
 */
#ifndef FUZZ_UTIL_H
#define FUZZ_UTIL_H

#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#define FUZZ_SEP 0x1E

/* Cap so a single pathological input cannot make one exec take seconds; the
 * merge engine is O(n^2) in a few places (UNION dedup, visited-pair set) by
 * design, and libFuzzer's own -max_len is a separate lever. */
#define FUZZ_MAX_INPUT 65536

typedef struct {
    char* a;
    char* b;
} fuzz_pair_t;

static char* fz_dup(const uint8_t* p, size_t n) {
    char* s = (char*)malloc(n + 1);
    if (!s) return NULL;
    if (n) memcpy(s, p, n);
    s[n] = '\0';
    return s;
}

/* Splits `data` on the first FUZZ_SEP byte. Returns both halves as
 * heap-allocated NUL-terminated strings (either may be NULL only on OOM). */
static fuzz_pair_t fz_split2(const uint8_t* data, size_t size) {
    fuzz_pair_t out = {NULL, NULL};
    const uint8_t* sep = (const uint8_t*)memchr(data, FUZZ_SEP, size);
    if (!sep) {
        out.a = fz_dup(data, size);
        out.b = fz_dup(data, size);
        return out;
    }
    out.a = fz_dup(data, (size_t)(sep - data));
    out.b = fz_dup(sep + 1, size - (size_t)(sep - data) - 1);
    return out;
}

static void fz_pair_free(fuzz_pair_t* p) {
    free(p->a);
    free(p->b);
    p->a = p->b = NULL;
}

#endif /* FUZZ_UTIL_H */
