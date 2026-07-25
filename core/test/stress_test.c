/*
 * stress_test.c — MANUAL performance/stress harness for the syncer core.
 *
 * NOT part of the default test target and NOT wired into any Makefile /
 * CMake target on purpose: it measures wall-clock time of deliberately
 * worst-case workloads (including the O(n*m) MERGE_BY_KEY identity scan),
 * so its runtime varies by machine and it asserts only correctness
 * invariants, not timing thresholds.
 *
 * Build and run by hand, e.g.:
 *   cc -O2 -Icore/include -Icore/src -o /tmp/stress_test \
 *      core/test/stress_test.c core/src/syncer.c core/src/yyjson.c
 *   /tmp/stress_test
 *
 * Workloads:
 *   (a) two 10,000-element MERGE_BY_KEY arrays with permuted ids
 *       (worst-case quadratic matching: 10k x 10k identity comparisons)
 *   (b) one ~5 MB deeply-mixed document merged with a mutated copy
 *   (c) 1,000 iterations of a 100-element MERGE_BY_KEY array merge
 */

#include "syncer.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

static double now_sec(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (double)ts.tv_sec + (double)ts.tv_nsec / 1e9;
}

static void die(const char* msg) {
    fprintf(stderr, "FATAL: %s\n", msg);
    exit(1);
}

/* ---------------------------------------------------------------------- */
/* Growable string buffer                                                  */
/* ---------------------------------------------------------------------- */
typedef struct {
    char*  data;
    size_t len;
    size_t cap;
} buf_t;

static void buf_init(buf_t* b, size_t cap) {
    b->data = (char*)malloc(cap);
    if (!b->data) die("out of memory");
    b->len = 0;
    b->cap = cap;
}

static void buf_appendf(buf_t* b, const char* fmt, ...) {
    va_list ap;
    for (;;) {
        va_start(ap, fmt);
        int n = vsnprintf(b->data + b->len, b->cap - b->len, fmt, ap);
        va_end(ap);
        if (n < 0) die("vsnprintf failed");
        if ((size_t)n < b->cap - b->len) {
            b->len += (size_t)n;
            return;
        }
        b->cap *= 2;
        b->data = (char*)realloc(b->data, b->cap);
        if (!b->data) die("out of memory");
    }
}

/* ---------------------------------------------------------------------- */
/* Document builders                                                       */
/* ---------------------------------------------------------------------- */

/*
 * {"items":[ n objects ]} where element ids are the permutation
 * (i*stride + offset) mod n. stride must be coprime with n so the incoming
 * array is fully reordered relative to the base — every identity lookup
 * walks a different distance, exercising the O(n*m) scan honestly.
 */
static char* build_keyed_array(int n, int stride, int offset, const char* tag) {
    buf_t b;
    buf_init(&b, (size_t)n * 80 + 64);
    buf_appendf(&b, "{\"items\":[");
    for (int i = 0; i < n; i++) {
        int id = (i * stride + offset) % n;
        buf_appendf(&b,
                    "%s{\"id\":%d,\"updatedAt\":%d,\"name\":\"%s-%d\",\"score\":%d}",
                    i ? "," : "", id, 1000 + i, tag, id, i * 7);
    }
    buf_appendf(&b, "]}");
    return b.data;
}

/*
 * Deeply-mixed document of roughly `target_bytes` bytes: an object of
 * "section" objects, each holding nested objects, strings, numbers,
 * booleans, nulls and small arrays, several levels deep.
 */
static char* build_mixed_doc(size_t target_bytes, const char* tag) {
    buf_t b;
    buf_init(&b, target_bytes + 4096);
    buf_appendf(&b, "{");
    int section = 0;
    while (b.len < target_bytes) {
        buf_appendf(&b,
            "%s\"section_%d\":{"
              "\"meta\":{\"updatedAt\":%d,\"origin\":\"%s\",\"flags\":[true,false,null]},"
              "\"payload\":{"
                "\"level1\":{"
                  "\"level2\":{"
                    "\"level3\":{"
                      "\"text\":\"%s lorem ipsum dolor sit amet consectetur adipiscing elit %d\","
                      "\"num\":%d.%d,"
                      "\"list\":[%d,%d,%d,\"%s-x%d\",{\"leaf\":%d}]"
                    "}"
                  "}"
                "},"
                "\"tags\":[\"alpha_%d\",\"beta_%d\",\"gamma_%d\"]"
              "}"
            "}",
            section ? "," : "", section,
            100000 + section, tag,
            tag, section,
            section, section % 997,
            section, section + 1, section + 2, tag, section, section * 3,
            section, section + 7, section + 13);
        section++;
    }
    buf_appendf(&b, "}");
    return b.data;
}

/* ---------------------------------------------------------------------- */
/* Helpers                                                                 */
/* ---------------------------------------------------------------------- */

static int count_occurrences(const char* haystack, const char* needle) {
    int count = 0;
    size_t nlen = strlen(needle);
    const char* p = haystack;
    while ((p = strstr(p, needle)) != NULL) {
        count++;
        p += nlen;
    }
    return count;
}

static syncer_merge_options_t stress_opts(void) {
    syncer_merge_options_t opts = syncer_default_options();
    opts.array_strategy = SYNCER_ARRAY_MERGE_BY_KEY;
    opts.resolve_by_timestamp = true;
    opts.lww_keys = "updatedAt,syncedAt";
    opts.fww_keys = "createdAt";
    opts.array_match_keys = "id";
    return opts;
}

/* ---------------------------------------------------------------------- */
/* Workloads                                                               */
/* ---------------------------------------------------------------------- */

static void workload_a_10k_merge_by_key(void) {
    const int n = 10000;
    printf("(a) MERGE_BY_KEY %dx%d permuted arrays (worst-case O(n*m) matching)\n",
           n, n);

    char* base = build_keyed_array(n, 1, 0, "base");
    /* stride 7 is coprime with 10000: same id set, fully permuted order */
    char* incoming = build_keyed_array(n, 7, 3, "inc");
    printf("    base=%zu bytes, incoming=%zu bytes\n",
           strlen(base), strlen(incoming));

    syncer_merge_options_t opts = stress_opts();

    double t0 = now_sec();
    char* out = syncer_merge_json_ex(base, incoming, &opts);
    double t1 = now_sec();

    if (!out) die("(a) merge returned NULL");
    /* Every id must appear exactly once — no duplicates, no drops. */
    if (count_occurrences(out, "\"id\":9999,") + count_occurrences(out, "\"id\":9999}") != 1)
        die("(a) id 9999 not merged exactly once");
    if (count_occurrences(out, "\"id\":0,") + count_occurrences(out, "\"id\":0}") != 1)
        die("(a) id 0 not merged exactly once");

    printf("    wall time: %.3f s  (output %zu bytes)\n\n", t1 - t0, strlen(out));

    syncer_free(out);
    free(base);
    free(incoming);
}

static void workload_b_5mb_mixed_doc(void) {
    const size_t target = 5u * 1024u * 1024u;
    printf("(b) ~5 MB deeply-mixed document merge\n");

    char* base = build_mixed_doc(target, "base");
    char* incoming = build_mixed_doc(target, "incoming");
    printf("    base=%.2f MB, incoming=%.2f MB\n",
           strlen(base) / 1048576.0, strlen(incoming) / 1048576.0);

    syncer_merge_options_t opts = syncer_default_options();
    opts.resolve_by_timestamp = true;
    opts.lww_keys = "updatedAt";
    opts.array_strategy = SYNCER_ARRAY_UNION;

    double t0 = now_sec();
    char* out = syncer_merge_json_ex(base, incoming, &opts);
    double t1 = now_sec();

    if (!out) die("(b) merge returned NULL");
    if (strstr(out, "\"section_0\"") == NULL) die("(b) output lost section_0");

    printf("    wall time: %.3f s  (output %.2f MB)\n\n",
           t1 - t0, strlen(out) / 1048576.0);

    syncer_free(out);
    free(base);
    free(incoming);
}

static void workload_c_1000x100_iterations(void) {
    const int n = 100;
    const int iters = 1000;
    printf("(c) %d iterations of a %d-element MERGE_BY_KEY array merge\n",
           iters, n);

    char* base = build_keyed_array(n, 1, 0, "base");
    char* incoming = build_keyed_array(n, 3, 1, "inc"); /* 3 coprime with 100 */

    syncer_merge_options_t opts = stress_opts();

    /* Correctness gate before timing */
    char* probe = syncer_merge_json_ex(base, incoming, &opts);
    if (!probe) die("(c) merge returned NULL");
    if (count_occurrences(probe, "\"id\":99,") + count_occurrences(probe, "\"id\":99}") != 1)
        die("(c) id 99 not merged exactly once");
    syncer_free(probe);

    double t0 = now_sec();
    for (int i = 0; i < iters; i++) {
        char* out = syncer_merge_json_ex(base, incoming, &opts);
        if (!out) die("(c) merge returned NULL mid-loop");
        syncer_free(out);
    }
    double t1 = now_sec();

    double total = t1 - t0;
    printf("    aggregate: %.3f s for %d merges  (%.1f us/merge, %.0f merges/s)\n\n",
           total, iters, total / iters * 1e6, iters / total);

    free(base);
    free(incoming);
}

int main(void) {
    printf("syncer stress harness — core v%s (manual perf runs only)\n\n",
           syncer_version());
    workload_a_10k_merge_by_key();
    workload_b_5mb_mixed_doc();
    workload_c_1000x100_iterations();
    printf("all stress workloads completed without crashes\n");
    return 0;
}
