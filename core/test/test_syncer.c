/*
 * test_syncer.c — Comprehensive test suite for the syncer deep-merge engine.
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <assert.h>
#include "syncer.h"

static int tests_run   = 0;
static int tests_passed = 0;

#define TEST(name) do { \
    printf("  TEST: %-50s ", #name); \
    tests_run++; \
    name(); \
    tests_passed++; \
    printf("PASS\n"); \
} while(0)

/* Helper: check that a key has a specific string value in the merged JSON */
static int json_has_str(const char* json, const char* key, const char* expected) {
    /* Simple substring search — good enough for testing */
    char pattern[512];
    snprintf(pattern, sizeof(pattern), "\"%s\":\"%s\"", key, expected);
    return strstr(json, pattern) != NULL;
}

static int json_has_num(const char* json, const char* key, int expected) {
    char pattern[512];
    snprintf(pattern, sizeof(pattern), "\"%s\":%d", key, expected);
    return strstr(json, pattern) != NULL;
}

/* ========================================================================== */
/*  Test: Simple flat object merge                                            */
/* ========================================================================== */

static void test_flat_merge(void) {
    const char* j1 = "{\"a\":1,\"b\":2}";
    const char* j2 = "{\"b\":3,\"c\":4}";
    char* result = syncer_merge_json(j1, j2, NULL);
    assert(result != NULL);
    assert(json_has_num(result, "a", 1));
    assert(json_has_num(result, "b", 3));  /* v2 overwrites */
    assert(json_has_num(result, "c", 4));  /* new key from v2 */
    syncer_free(result);
}

/* ========================================================================== */
/*  Test: Deeply nested merge (10+ levels)                                    */
/* ========================================================================== */

static void test_deep_nested_merge(void) {
    const char* j1 = "{\"l1\":{\"l2\":{\"l3\":{\"l4\":{\"l5\":{\"l6\":{\"l7\":{\"l8\":{\"l9\":{\"l10\":{\"deep\":\"v1\"}}}}}}}}}}}";
    const char* j2 = "{\"l1\":{\"l2\":{\"l3\":{\"l4\":{\"l5\":{\"l6\":{\"l7\":{\"l8\":{\"l9\":{\"l10\":{\"deep\":\"v2\",\"new\":true}}}}}}}}}}}";
    char* result = syncer_merge_json(j1, j2, NULL);
    assert(result != NULL);
    assert(json_has_str(result, "deep", "v2"));
    assert(strstr(result, "\"new\":true") != NULL);
    syncer_free(result);
}

/* ========================================================================== */
/*  Test: Array merge strategies                                              */
/* ========================================================================== */

static void test_array_replace(void) {
    const char* j1 = "{\"arr\":[1,2,3]}";
    const char* j2 = "{\"arr\":[4,5]}";
    syncer_merge_options_t opts = syncer_default_options();
    opts.array_strategy = SYNCER_ARRAY_REPLACE;
    char* result = syncer_merge_json_ex(j1, j2, &opts);
    assert(result != NULL);
    assert(strstr(result, "[4,5]") != NULL);
    assert(strstr(result, "1") == NULL || strstr(result, "[1") == NULL);
    syncer_free(result);
}

static void test_array_append(void) {
    const char* j1 = "{\"arr\":[1,2,3]}";
    const char* j2 = "{\"arr\":[4,5]}";
    syncer_merge_options_t opts = syncer_default_options();
    opts.array_strategy = SYNCER_ARRAY_APPEND;
    char* result = syncer_merge_json_ex(j1, j2, &opts);
    assert(result != NULL);
    assert(strstr(result, "[1,2,3,4,5]") != NULL);
    syncer_free(result);
}

static void test_array_union(void) {
    const char* j1 = "{\"arr\":[1,2,3]}";
    const char* j2 = "{\"arr\":[2,3,4]}";
    syncer_merge_options_t opts = syncer_default_options();
    opts.array_strategy = SYNCER_ARRAY_UNION;
    char* result = syncer_merge_json_ex(j1, j2, &opts);
    assert(result != NULL);
    /* Should have 1,2,3,4 — no duplicates of 2 and 3 */
    assert(strstr(result, "[1,2,3,4]") != NULL);
    syncer_free(result);
}

static void test_array_merge_by_index(void) {
    const char* j1 = "{\"arr\":[{\"name\":\"alice\"},{\"name\":\"bob\"}]}";
    const char* j2 = "{\"arr\":[{\"age\":30},{\"age\":25}]}";
    syncer_merge_options_t opts = syncer_default_options();
    opts.array_strategy = SYNCER_ARRAY_MERGE_BY_INDEX;
    char* result = syncer_merge_json_ex(j1, j2, &opts);
    assert(result != NULL);
    assert(json_has_str(result, "name", "alice"));
    assert(json_has_num(result, "age", 30));
    assert(json_has_str(result, "name", "bob"));
    assert(json_has_num(result, "age", 25));
    syncer_free(result);
}

/* ========================================================================== */
/*  Test: Override callback receives correct JSON path                        */
/* ========================================================================== */

static char* captured_paths[32];
static int   captured_count = 0;

static char* path_capture_cb(const char* json_path, const char* val1, const char* val2) {
    (void)val1;
    (void)val2;
    if (captured_count < 32) {
        captured_paths[captured_count++] = strdup(json_path);
    }
    return NULL; /* use default merge */
}

static void test_callback_receives_path(void) {
    captured_count = 0;
    const char* j1 = "{\"user\":{\"profile\":{\"name\":\"old\"}}}";
    const char* j2 = "{\"user\":{\"profile\":{\"name\":\"new\"}}}";
    syncer_merge_options_t opts = syncer_default_options();
    opts.override_cb = path_capture_cb;
    char* result = syncer_merge_json_ex(j1, j2, &opts);
    assert(result != NULL);

    /* Should have received path "$.user.profile.name" */
    int found = 0;
    for (int i = 0; i < captured_count; i++) {
        if (strcmp(captured_paths[i], "$.user.profile.name") == 0) found = 1;
        free(captured_paths[i]);
    }
    assert(found);
    syncer_free(result);
}

/* ========================================================================== */
/*  Test: Max depth enforcement                                               */
/* ========================================================================== */

static void test_max_depth(void) {
    const char* j1 = "{\"a\":{\"b\":{\"c\":{\"deep\":\"v1\"}}}}";
    const char* j2 = "{\"a\":{\"b\":{\"c\":{\"deep\":\"v2\"}}}}";
    syncer_merge_options_t opts = syncer_default_options();
    opts.max_depth = 2; /* Stop merging at depth 2 */
    char* result = syncer_merge_json_ex(j1, j2, &opts);
    assert(result != NULL);
    /* At depth 2, the "c" object should be replaced wholesale by v2's "c" */
    assert(json_has_str(result, "deep", "v2"));
    syncer_free(result);
}

/* ========================================================================== */
/*  Test: Extremely deep nesting (1000 levels) — proves no stack overflow     */
/* ========================================================================== */

static char* make_deep_json(int depth, const char* leaf_key, const char* leaf_val) {
    /* Build: {"k":{"k":{"k":...:{"leaf_key":"leaf_val"}}...}} */
    size_t bufsz = (size_t)(depth * 6 + 256);
    char* buf = (char*)malloc(bufsz);
    size_t pos = 0;
    for (int i = 0; i < depth; i++) {
        pos += (size_t)snprintf(buf + pos, bufsz - pos, "{\"k\":");
    }
    pos += (size_t)snprintf(buf + pos, bufsz - pos, "{\"%s\":\"%s\"}", leaf_key, leaf_val);
    for (int i = 0; i < depth; i++) {
        buf[pos++] = '}';
    }
    buf[pos] = '\0';
    return buf;
}

static void test_extreme_depth(void) {
    char* j1 = make_deep_json(1000, "val", "one");
    char* j2 = make_deep_json(1000, "val", "two");
    char* result = syncer_merge_json(j1, j2, NULL);
    assert(result != NULL);
    assert(json_has_str(result, "val", "two"));
    free(j1);
    free(j2);
    syncer_free(result);
}

/* ========================================================================== */
/*  Test: Mixed types (object in v1, string in v2 at same key)                */
/* ========================================================================== */

static void test_mixed_types(void) {
    const char* j1 = "{\"data\":{\"nested\":true}}";
    const char* j2 = "{\"data\":\"replaced_with_string\"}";
    char* result = syncer_merge_json(j1, j2, NULL);
    assert(result != NULL);
    assert(json_has_str(result, "data", "replaced_with_string"));
    syncer_free(result);
}

/* ========================================================================== */
/*  Test: NULL and edge cases                                                 */
/* ========================================================================== */

static void test_null_inputs(void) {
    assert(syncer_merge_json(NULL, NULL, NULL) == NULL);

    char* r1 = syncer_merge_json(NULL, "{\"a\":1}", NULL);
    assert(r1 != NULL);
    assert(json_has_num(r1, "a", 1));
    syncer_free(r1);

    char* r2 = syncer_merge_json("{\"b\":2}", NULL, NULL);
    assert(r2 != NULL);
    assert(json_has_num(r2, "b", 2));
    syncer_free(r2);
}

static void test_invalid_json(void) {
    char* r = syncer_merge_json("{invalid", "{}", NULL);
    assert(r == NULL);
}

/* ========================================================================== */
/*  Test: Legacy API backwards compatibility                                  */
/* ========================================================================== */

static char* legacy_override(const char* key, const char* val1, const char* val2) {
    (void)val1;
    (void)val2;
    if (strcmp(key, "priority") == 0) {
        return strdup("999");
    }
    return NULL;
}

static void test_legacy_api(void) {
    const char* j1 = "{\"priority\":1,\"name\":\"base\"}";
    const char* j2 = "{\"priority\":2,\"name\":\"incoming\"}";
    char* result = syncer_merge_json(j1, j2, legacy_override);
    assert(result != NULL);
    assert(json_has_num(result, "priority", 999)); /* override took effect */
    assert(json_has_str(result, "name", "incoming")); /* default merge */
    syncer_free(result);
}

/* ========================================================================== */
/*  Test: Circular reference detection                                        */
/* ========================================================================== */

static void test_circular_ref_detection(void) {
    /* Since yyjson parses from string, there can't be true pointer cycles.
       But we test that the detect_circular_refs flag doesn't crash 
       and that the visited set works correctly on deeply shared structures. */
    const char* j1 = "{\"a\":{\"b\":{\"c\":1}},\"d\":{\"b\":{\"c\":2}}}";
    const char* j2 = "{\"a\":{\"b\":{\"c\":3}},\"d\":{\"b\":{\"c\":4}}}";
    syncer_merge_options_t opts = syncer_default_options();
    opts.detect_circular_refs = true;
    char* result = syncer_merge_json_ex(j1, j2, &opts);
    assert(result != NULL);
    syncer_free(result);
}

/* ========================================================================== */
/*  Test: CRDT Timestamp Resolution                                           */
/* ========================================================================== */

static void test_crdt_timestamp_resolution(void) {
    syncer_merge_options_t opts = syncer_default_options();
    opts.resolve_by_timestamp = true;
    opts.lww_keys = "updatedAt";

    /* Case 1: Base is newer (Integer nanoseconds). Incoming should be dropped. */
    const char* j1 = "{\"doc\":{\"updatedAt\":1689940800,\"val\":\"base\"}}";
    const char* j2 = "{\"doc\":{\"updatedAt\":1689940000,\"val\":\"incoming\"}}";
    char* r1 = syncer_merge_json_ex(j1, j2, &opts);
    assert(r1 != NULL);
    assert(json_has_str(r1, "val", "base")); /* kept base */
    syncer_free(r1);

    /* Case 2: Incoming is newer. Incoming should overwrite. */
    const char* j3 = "{\"doc\":{\"updatedAt\":1689940000,\"val\":\"base\"}}";
    const char* j4 = "{\"doc\":{\"updatedAt\":1689940800,\"val\":\"incoming\"}}";
    char* r2 = syncer_merge_json_ex(j3, j4, &opts);
    assert(r2 != NULL);
    assert(json_has_str(r2, "val", "incoming")); /* took incoming */
    syncer_free(r2);

    /* Case 3: Same key inside array elements (MERGE_BY_INDEX) */
    opts.array_strategy = SYNCER_ARRAY_MERGE_BY_INDEX;
    const char* j5 = "{\"arr\":[{\"updatedAt\":100,\"v\":1}]}";
    const char* j6 = "{\"arr\":[{\"updatedAt\":50,\"v\":2}]}";
    char* r3 = syncer_merge_json_ex(j5, j6, &opts);
    assert(r3 != NULL);
    assert(json_has_num(r3, "v", 1)); /* kept base element */
    syncer_free(r3);

    /* Case 4: First-Write-Wins (createdAt). Base is older, incoming is newer. Incoming should be dropped. */
    opts.fww_keys = "createdAt";
    const char* j7 = "{\"doc\":{\"createdAt\":100,\"val\":\"original\"}}";
    const char* j8 = "{\"doc\":{\"createdAt\":200,\"val\":\"new\"}}";
    char* r4 = syncer_merge_json_ex(j7, j8, &opts);
    assert(r4 != NULL);
    assert(json_has_str(r4, "val", "original")); /* kept original */
    syncer_free(r4);

    /* Case 5: First-Write-Wins (createdAt). Base is newer, incoming is older. Incoming should be accepted. */
    const char* j9 = "{\"doc\":{\"createdAt\":500,\"val\":\"wrong\"}}";
    const char* j10 = "{\"doc\":{\"createdAt\":100,\"val\":\"correct\"}}";
    char* r5 = syncer_merge_json_ex(j9, j10, &opts);
    assert(r5 != NULL);
    assert(json_has_str(r5, "val", "correct")); /* took incoming */
    syncer_free(r5);
}

/* ========================================================================== */
/*  Test: CRDT string timestamps compare numerically, not lexicographically   */
/* ========================================================================== */

static void test_crdt_string_timestamps(void) {
    syncer_merge_options_t opts = syncer_default_options();
    opts.resolve_by_timestamp = true;
    opts.lww_keys = "updatedAt";

    /* Digit strings of different lengths: 10 > 9, even though strcmp("10","9") < 0.
       Incoming ("10") is newer -> must be accepted. */
    const char* j1 = "{\"doc\":{\"updatedAt\":\"9\",\"val\":\"base\"}}";
    const char* j2 = "{\"doc\":{\"updatedAt\":\"10\",\"val\":\"incoming\"}}";
    char* r1 = syncer_merge_json_ex(j1, j2, &opts);
    assert(r1 != NULL);
    assert(json_has_str(r1, "val", "incoming"));
    syncer_free(r1);

    /* Reversed: base "10" is newer than incoming "9" -> incoming dropped. */
    char* r2 = syncer_merge_json_ex(j2, j1, &opts);
    assert(r2 != NULL);
    assert(json_has_str(r2, "val", "incoming")); /* base of this call */
    syncer_free(r2);

    /* Epoch-millis strings with realistic lengths. */
    const char* j3 = "{\"doc\":{\"updatedAt\":\"1689940800000\",\"val\":\"base\"}}";
    const char* j4 = "{\"doc\":{\"updatedAt\":\"999999999999\",\"val\":\"older\"}}"; /* 12 digits < 13 digits */
    char* r3 = syncer_merge_json_ex(j3, j4, &opts);
    assert(r3 != NULL);
    assert(json_has_str(r3, "val", "base")); /* older incoming rejected */
    syncer_free(r3);

    /* ISO-8601 strings are fixed-width: lexicographic == chronological. */
    const char* j5 = "{\"doc\":{\"updatedAt\":\"2026-07-24T10:00:00Z\",\"val\":\"base\"}}";
    const char* j6 = "{\"doc\":{\"updatedAt\":\"2026-07-23T10:00:00Z\",\"val\":\"older\"}}";
    char* r4 = syncer_merge_json_ex(j5, j6, &opts);
    assert(r4 != NULL);
    assert(json_has_str(r4, "val", "base"));
    syncer_free(r4);
}

/* ========================================================================== */
/*  Test: CRDT int-vs-string timestamp pairs still resolve (no type bypass)   */
/* ========================================================================== */

static void test_crdt_mixed_int_string_timestamps(void) {
    syncer_merge_options_t opts = syncer_default_options();
    opts.resolve_by_timestamp = true;
    opts.lww_keys = "updatedAt";

    /* Base int 100 vs incoming string "99": base newer -> incoming dropped. */
    const char* j1 = "{\"doc\":{\"updatedAt\":100,\"val\":\"base\"}}";
    const char* j2 = "{\"doc\":{\"updatedAt\":\"99\",\"val\":\"incoming\"}}";
    char* r1 = syncer_merge_json_ex(j1, j2, &opts);
    assert(r1 != NULL);
    assert(json_has_str(r1, "val", "base"));
    syncer_free(r1);

    /* Base string "99" vs incoming int 100: incoming newer -> accepted. */
    const char* j3 = "{\"doc\":{\"updatedAt\":\"99\",\"val\":\"base\"}}";
    const char* j4 = "{\"doc\":{\"updatedAt\":100,\"val\":\"incoming\"}}";
    char* r2 = syncer_merge_json_ex(j3, j4, &opts);
    assert(r2 != NULL);
    assert(json_has_str(r2, "val", "incoming"));
    syncer_free(r2);
}

/* ========================================================================== */
/*  Test: CRDT key lists longer than any internal buffer + spaces + equal ts  */
/* ========================================================================== */

static void test_crdt_long_key_list(void) {
    /* Build a keys list well past 256 chars with the real key at the END —
       a fixed-size internal copy would truncate it away. */
    char keys[512];
    size_t pos = 0;
    for (int i = 0; i < 30; i++) {
        pos += (size_t)snprintf(keys + pos, sizeof(keys) - pos, "padding_key_%02d,", i);
    }
    snprintf(keys + pos, sizeof(keys) - pos, "updatedAt");
    assert(strlen(keys) > 256);

    syncer_merge_options_t opts = syncer_default_options();
    opts.resolve_by_timestamp = true;
    opts.lww_keys = keys;

    const char* j1 = "{\"doc\":{\"updatedAt\":200,\"val\":\"base\"}}";
    const char* j2 = "{\"doc\":{\"updatedAt\":100,\"val\":\"stale\"}}";
    char* r = syncer_merge_json_ex(j1, j2, &opts);
    assert(r != NULL);
    assert(json_has_str(r, "val", "base")); /* stale incoming still rejected */
    syncer_free(r);
}

static void test_crdt_keys_with_spaces(void) {
    syncer_merge_options_t opts = syncer_default_options();
    opts.resolve_by_timestamp = true;
    opts.lww_keys = "updatedAt, syncedAt"; /* note the space */

    /* Only syncedAt present; base is newer -> incoming dropped. */
    const char* j1 = "{\"doc\":{\"syncedAt\":200,\"val\":\"base\"}}";
    const char* j2 = "{\"doc\":{\"syncedAt\":100,\"val\":\"stale\"}}";
    char* r = syncer_merge_json_ex(j1, j2, &opts);
    assert(r != NULL);
    assert(json_has_str(r, "val", "base"));
    syncer_free(r);
}

static void test_crdt_equal_timestamps_merge(void) {
    syncer_merge_options_t opts = syncer_default_options();
    opts.resolve_by_timestamp = true;
    opts.lww_keys = "updatedAt";

    /* Equal stamps: neither side is "newer" -> normal merge, v2 field wins. */
    const char* j1 = "{\"doc\":{\"updatedAt\":100,\"val\":\"base\",\"keep\":1}}";
    const char* j2 = "{\"doc\":{\"updatedAt\":100,\"val\":\"incoming\"}}";
    char* r = syncer_merge_json_ex(j1, j2, &opts);
    assert(r != NULL);
    assert(json_has_str(r, "val", "incoming"));
    assert(json_has_num(r, "keep", 1)); /* sibling untouched */
    syncer_free(r);
}

/* ========================================================================== */
/*  Test: one-sided merges validate the present side                          */
/* ========================================================================== */

static void test_one_sided_null_validates(void) {
    /* Invalid JSON on the only present side must return NULL, matching the
       documented contract — never echo unparsed input back to the caller. */
    assert(syncer_merge_json(NULL, "{not json", NULL) == NULL);
    assert(syncer_merge_json("{not json", NULL, NULL) == NULL);

    /* Valid one-sided input round-trips (normalized). */
    char* r = syncer_merge_json(NULL, "{ \"a\" : 1 }", NULL);
    assert(r != NULL);
    assert(json_has_num(r, "a", 1));
    syncer_free(r);
}

/* ========================================================================== */
/*  Test: an override returning unparseable JSON falls back to default merge  */
/* ========================================================================== */

static char* bad_json_override(const char* json_path, const char* val1, const char* val2) {
    (void)val1;
    (void)val2;
    if (strcmp(json_path, "$.user") == 0) {
        char* junk = (char*)malloc(8);
        strcpy(junk, "{oops");
        return junk;
    }
    return NULL;
}

static void test_callback_bad_json_falls_back(void) {
    const char* j1 = "{\"user\":{\"name\":\"old\",\"keep\":1}}";
    const char* j2 = "{\"user\":{\"name\":\"new\"}}";
    syncer_merge_options_t opts = syncer_default_options();
    opts.override_cb = bad_json_override;
    char* r = syncer_merge_json_ex(j1, j2, &opts);
    assert(r != NULL);
    /* The bad override must not drop v2's subtree NOR clobber v1's siblings:
       default deep merge proceeds. */
    assert(json_has_str(r, "name", "new"));
    assert(json_has_num(r, "keep", 1));
    syncer_free(r);
}

/* ========================================================================== */
/*  Test: UNION dedups whole objects; max_depth=1 replaces at the first level */
/* ========================================================================== */

static void test_union_dedups_objects(void) {
    const char* j1 = "{\"arr\":[{\"a\":1}]}";
    const char* j2 = "{\"arr\":[{\"a\":1},{\"b\":2}]}";
    syncer_merge_options_t opts = syncer_default_options();
    opts.array_strategy = SYNCER_ARRAY_UNION;
    char* r = syncer_merge_json_ex(j1, j2, &opts);
    assert(r != NULL);
    assert(strstr(r, "[{\"a\":1},{\"b\":2}]") != NULL); /* {"a":1} not duplicated */
    syncer_free(r);
}

static void test_max_depth_one(void) {
    const char* j1 = "{\"a\":{\"x\":1},\"b\":2}";
    const char* j2 = "{\"a\":{\"y\":9}}";
    syncer_merge_options_t opts = syncer_default_options();
    opts.max_depth = 1;
    char* r = syncer_merge_json_ex(j1, j2, &opts);
    assert(r != NULL);
    /* At depth 1 the "a" subtree is leaf-merged: v2 replaces it wholesale. */
    assert(json_has_num(r, "y", 9));
    assert(strstr(r, "\"x\"") == NULL);
    assert(json_has_num(r, "b", 2)); /* untouched sibling survives */
    syncer_free(r);
}

/* ========================================================================== */
/*  Test: MERGE_BY_KEY — reconcile objects-in-arrays by identity key          */
/* ========================================================================== */

static void test_merge_by_key_basic(void) {
    /* Matched id=1 deep-merges; id=3 appends; id=2 (v1-only) survives. */
    const char* j1 = "{\"items\":[{\"id\":1,\"name\":\"alpha\",\"qty\":5},{\"id\":2,\"name\":\"beta\"}]}";
    const char* j2 = "{\"items\":[{\"id\":1,\"qty\":7},{\"id\":3,\"name\":\"gamma\"}]}";
    syncer_merge_options_t opts = syncer_default_options();
    opts.array_strategy = SYNCER_ARRAY_MERGE_BY_KEY;
    char* r = syncer_merge_json_ex(j1, j2, &opts);
    assert(r != NULL);
    assert(json_has_str(r, "name", "alpha"));   /* kept from v1 on merged elem */
    assert(json_has_num(r, "qty", 7));          /* updated from v2 */
    assert(json_has_str(r, "name", "beta"));    /* v1-only element kept */
    assert(json_has_str(r, "name", "gamma"));   /* new element appended */
    assert(strstr(r, "\"qty\":5") == NULL);
    syncer_free(r);
}

static void test_merge_by_key_lww_timestamps(void) {
    /* Per-element LWW: stale incoming element rejected, fresh one accepted —
       both in the SAME array, which MERGE_BY_INDEX cannot express when order
       differs. */
    syncer_merge_options_t opts = syncer_default_options();
    opts.array_strategy = SYNCER_ARRAY_MERGE_BY_KEY;
    opts.resolve_by_timestamp = true;
    opts.lww_keys = "updatedAt,syncedAt";
    const char* j1 = "{\"rows\":["
        "{\"id\":\"a\",\"updatedAt\":200,\"val\":\"base-a\"},"
        "{\"id\":\"b\",\"updatedAt\":100,\"val\":\"base-b\"}]}";
    const char* j2 = "{\"rows\":["
        "{\"id\":\"b\",\"updatedAt\":150,\"val\":\"new-b\"},"
        "{\"id\":\"a\",\"updatedAt\":100,\"val\":\"stale-a\"}]}";
    char* r = syncer_merge_json_ex(j1, j2, &opts);
    assert(r != NULL);
    assert(json_has_str(r, "val", "base-a"));  /* stale incoming rejected */
    assert(json_has_str(r, "val", "new-b"));   /* fresh incoming accepted */
    assert(strstr(r, "stale-a") == NULL);
    assert(strstr(r, "base-b") == NULL);
    syncer_free(r);
}

static void test_merge_by_key_fww_created_at(void) {
    /* FWW on createdAt: an incoming element claiming a LATER creation for the
       same identity is rejected wholesale. */
    syncer_merge_options_t opts = syncer_default_options();
    opts.array_strategy = SYNCER_ARRAY_MERGE_BY_KEY;
    opts.resolve_by_timestamp = true;
    opts.fww_keys = "createdAt";
    const char* j1 = "{\"rows\":[{\"id\":1,\"createdAt\":100,\"who\":\"original\"}]}";
    const char* j2 = "{\"rows\":[{\"id\":1,\"createdAt\":300,\"who\":\"impostor\"}]}";
    char* r = syncer_merge_json_ex(j1, j2, &opts);
    assert(r != NULL);
    assert(json_has_str(r, "who", "original"));
    assert(strstr(r, "impostor") == NULL);
    syncer_free(r);
}

static void test_merge_by_key_id_type_normalization(void) {
    /* Numeric id 42 must match string id "42" — no duplicate row. */
    syncer_merge_options_t opts = syncer_default_options();
    opts.array_strategy = SYNCER_ARRAY_MERGE_BY_KEY;
    const char* j1 = "{\"rows\":[{\"id\":42,\"v\":\"old\"}]}";
    const char* j2 = "{\"rows\":[{\"id\":\"42\",\"v\":\"new\"}]}";
    char* r = syncer_merge_json_ex(j1, j2, &opts);
    assert(r != NULL);
    assert(json_has_str(r, "v", "new"));
    assert(strstr(r, "old") == NULL);
    /* exactly one row */
    assert(strstr(r, "},{") == NULL);
    syncer_free(r);
}

static void test_merge_by_key_custom_match_keys(void) {
    /* "uuid,id": uuid is the identity when present; elements without uuid
       fall back to id. */
    syncer_merge_options_t opts = syncer_default_options();
    opts.array_strategy = SYNCER_ARRAY_MERGE_BY_KEY;
    opts.array_match_keys = "uuid,id";
    const char* j1 = "{\"rows\":[{\"uuid\":\"u-1\",\"v\":1},{\"id\":7,\"v\":2}]}";
    const char* j2 = "{\"rows\":[{\"uuid\":\"u-1\",\"v\":10},{\"id\":7,\"v\":20}]}";
    char* r = syncer_merge_json_ex(j1, j2, &opts);
    assert(r != NULL);
    assert(json_has_num(r, "v", 10));
    assert(json_has_num(r, "v", 20));
    assert(strstr(r, "\"v\":1,") == NULL && strstr(r, "\"v\":1}") == NULL);
    assert(strstr(r, "\"v\":2}") == NULL && strstr(r, "\"v\":2,") == NULL);
    syncer_free(r);
}

static void test_merge_by_key_idempotent(void) {
    /* Merging the same payload twice must be a no-op (critical for sync
       retries): matched ids re-merge in place, scalars union. */
    syncer_merge_options_t opts = syncer_default_options();
    opts.array_strategy = SYNCER_ARRAY_MERGE_BY_KEY;
    const char* j1 = "{\"rows\":[{\"id\":1,\"v\":1}],\"tags\":[\"x\",\"y\"]}";
    const char* j2 = "{\"rows\":[{\"id\":1,\"v\":2},{\"id\":2,\"v\":3}],\"tags\":[\"y\",\"z\"]}";
    char* once = syncer_merge_json_ex(j1, j2, &opts);
    assert(once != NULL);
    char* twice = syncer_merge_json_ex(once, j2, &opts);
    assert(twice != NULL);
    assert(strcmp(once, twice) == 0);
    syncer_free(once);
    syncer_free(twice);
}

static void test_merge_by_key_nested_deep_merge(void) {
    /* Matched elements deep-merge their nested objects, and nested arrays of
       keyed objects reconcile too. */
    syncer_merge_options_t opts = syncer_default_options();
    opts.array_strategy = SYNCER_ARRAY_MERGE_BY_KEY;
    const char* j1 = "{\"rows\":[{\"id\":1,\"meta\":{\"a\":1,\"b\":2},"
                     "\"children\":[{\"id\":\"c1\",\"n\":\"kid\"}]}]}";
    const char* j2 = "{\"rows\":[{\"id\":1,\"meta\":{\"b\":3},"
                     "\"children\":[{\"id\":\"c1\",\"age\":4},{\"id\":\"c2\",\"n\":\"kid2\"}]}]}";
    char* r = syncer_merge_json_ex(j1, j2, &opts);
    assert(r != NULL);
    assert(json_has_num(r, "a", 1));          /* nested obj kept */
    assert(json_has_num(r, "b", 3));          /* nested obj updated */
    assert(json_has_str(r, "n", "kid"));      /* nested matched child kept fields */
    assert(json_has_num(r, "age", 4));        /* nested matched child merged */
    assert(json_has_str(r, "n", "kid2"));     /* nested new child appended */
    syncer_free(r);
}

static void test_merge_by_key_mixed_and_missing_ids(void) {
    /* Scalars and id-less objects get UNION semantics; keyed objects merge. */
    syncer_merge_options_t opts = syncer_default_options();
    opts.array_strategy = SYNCER_ARRAY_MERGE_BY_KEY;
    const char* j1 = "{\"arr\":[1,{\"note\":\"free\"},{\"id\":1,\"v\":\"a\"}]}";
    const char* j2 = "{\"arr\":[1,2,{\"note\":\"free\"},{\"id\":1,\"v\":\"b\"}]}";
    char* r = syncer_merge_json_ex(j1, j2, &opts);
    assert(r != NULL);
    assert(json_has_str(r, "v", "b"));
    /* scalar 1 and {"note":"free"} not duplicated; 2 appended */
    assert(strstr(r, "\"note\":\"free\"}") != NULL);
    assert(strstr(r, "[1,{") != NULL);
    assert(strstr(r, ",2]") != NULL || strstr(r, ",2,") != NULL);
    syncer_free(r);
}

static void test_merge_by_key_at_root(void) {
    /* Root-level arrays (whole jsonb column is an array) reconcile too. */
    syncer_merge_options_t opts = syncer_default_options();
    opts.array_strategy = SYNCER_ARRAY_MERGE_BY_KEY;
    opts.resolve_by_timestamp = true;
    const char* j1 = "[{\"id\":1,\"updatedAt\":200,\"v\":\"keep\"}]";
    const char* j2 = "[{\"id\":1,\"updatedAt\":100,\"v\":\"stale\"},{\"id\":2,\"v\":\"new\"}]";
    char* r = syncer_merge_json_ex(j1, j2, &opts);
    assert(r != NULL);
    assert(json_has_str(r, "v", "keep"));
    assert(json_has_str(r, "v", "new"));
    assert(strstr(r, "stale") == NULL);
    syncer_free(r);
}

static void test_version_string(void) {
    const char* v = syncer_version();
    assert(v != NULL && strlen(v) >= 5);
}

/* ========================================================================== */
/*  Test: float timestamps participate in CRDT resolution                     */
/* ========================================================================== */

static void test_crdt_float_timestamps(void) {
    syncer_merge_options_t opts = syncer_default_options();
    opts.resolve_by_timestamp = true;
    opts.lww_keys = "updatedAt";

    /* Fractional epoch seconds (Python time.time() style): base newer. */
    const char* j1 = "{\"doc\":{\"updatedAt\":1689940800.9,\"val\":\"base\"}}";
    const char* j2 = "{\"doc\":{\"updatedAt\":1689940800.1,\"val\":\"stale\"}}";
    char* r1 = syncer_merge_json_ex(j1, j2, &opts);
    assert(r1 != NULL);
    assert(json_has_str(r1, "val", "base"));
    syncer_free(r1);

    /* Incoming fractional stamp newer -> accepted. */
    char* r2 = syncer_merge_json_ex(j2, j1, &opts);
    assert(r2 != NULL);
    assert(json_has_str(r2, "val", "base")); /* "base" is incoming here */
    syncer_free(r2);

    /* Mixed int-vs-real still resolves: int 100 vs real 99.5 -> base newer. */
    const char* j3 = "{\"doc\":{\"updatedAt\":100,\"val\":\"base\"}}";
    const char* j4 = "{\"doc\":{\"updatedAt\":99.5,\"val\":\"stale\"}}";
    char* r3 = syncer_merge_json_ex(j3, j4, &opts);
    assert(r3 != NULL);
    assert(json_has_str(r3, "val", "base"));
    syncer_free(r3);

    /* Real-vs-int, incoming newer -> accepted. */
    const char* j5 = "{\"doc\":{\"updatedAt\":99.5,\"val\":\"old\"}}";
    const char* j6 = "{\"doc\":{\"updatedAt\":100,\"val\":\"new\"}}";
    char* r4 = syncer_merge_json_ex(j5, j6, &opts);
    assert(r4 != NULL);
    assert(json_has_str(r4, "val", "new"));
    syncer_free(r4);

    /* Per-element inside MERGE_BY_KEY arrays. */
    opts.array_strategy = SYNCER_ARRAY_MERGE_BY_KEY;
    const char* j7 = "{\"a\":[{\"id\":1,\"updatedAt\":200.75,\"v\":\"keep\"}]}";
    const char* j8 = "{\"a\":[{\"id\":1,\"updatedAt\":200.25,\"v\":\"stale\"}]}";
    char* r5 = syncer_merge_json_ex(j7, j8, &opts);
    assert(r5 != NULL);
    assert(json_has_str(r5, "v", "keep"));
    syncer_free(r5);
}

/* ========================================================================== */
/*  Test: int64 extremes and negative timestamps compare exactly              */
/* ========================================================================== */

static void test_crdt_int64_extremes(void) {
    syncer_merge_options_t opts = syncer_default_options();
    opts.resolve_by_timestamp = true;
    opts.lww_keys = "updatedAt";

    /* Nanosecond epochs near int64 range: differ only in the low digit, which
       a double comparison would lose. Base is newer by 1ns -> stale rejected. */
    const char* j1 = "{\"doc\":{\"updatedAt\":1689940800123456789,\"val\":\"base\"}}";
    const char* j2 = "{\"doc\":{\"updatedAt\":1689940800123456788,\"val\":\"stale\"}}";
    char* r1 = syncer_merge_json_ex(j1, j2, &opts);
    assert(r1 != NULL);
    assert(json_has_str(r1, "val", "base"));
    syncer_free(r1);

    /* Negative timestamps (pre-1970) order correctly: -100 < -50. */
    const char* j3 = "{\"doc\":{\"updatedAt\":-50,\"val\":\"base\"}}";
    const char* j4 = "{\"doc\":{\"updatedAt\":-100,\"val\":\"stale\"}}";
    char* r2 = syncer_merge_json_ex(j3, j4, &opts);
    assert(r2 != NULL);
    assert(json_has_str(r2, "val", "base"));
    syncer_free(r2);
}

/* ========================================================================== */
/*  Test: unicode + escaped keys survive merge and path building              */
/* ========================================================================== */

static void test_unicode_and_escaped_keys(void) {
    /* Multibyte keys, escaped quotes and dots in keys — merge must neither
       corrupt them nor confuse path bookkeeping. */
    const char* j1 = "{\"héllo\":{\"wörld\":1},\"a.b\":{\"c\":1},\"q\\\"k\":1}";
    const char* j2 = "{\"héllo\":{\"wörld\":2,\"日本\":3},\"a.b\":{\"d\":4},\"q\\\"k\":9}";
    char* r = syncer_merge_json(j1, j2, NULL);
    assert(r != NULL);
    assert(strstr(r, "\"wörld\":2") != NULL);
    assert(strstr(r, "\"日本\":3") != NULL);
    assert(strstr(r, "\"c\":1") != NULL);
    assert(strstr(r, "\"d\":4") != NULL);
    assert(strstr(r, "\"q\\\"k\":9") != NULL);
    syncer_free(r);

    /* String identity values with unicode match correctly in MERGE_BY_KEY. */
    syncer_merge_options_t opts = syncer_default_options();
    opts.array_strategy = SYNCER_ARRAY_MERGE_BY_KEY;
    const char* j3 = "{\"a\":[{\"id\":\"ключ\",\"v\":1}]}";
    const char* j4 = "{\"a\":[{\"id\":\"ключ\",\"v\":2}]}";
    char* r2 = syncer_merge_json_ex(j3, j4, &opts);
    assert(r2 != NULL);
    assert(json_has_num(r2, "v", 2));
    assert(strstr(r2, "},{") == NULL); /* matched, not duplicated */
    syncer_free(r2);
}

/* ========================================================================== */
/*  Test: UNION dedup is key-order independent                                */
/* ========================================================================== */

static void test_union_dedup_key_order_independent(void) {
    /* Regression: dedup used to compare serialized text, so an element whose
       keys had been reordered (exactly what Postgres jsonb does on every
       write) was never recognized as a duplicate — UNION degraded to APPEND
       and lost idempotency. */
    syncer_merge_options_t opts = syncer_default_options();
    opts.array_strategy = SYNCER_ARRAY_UNION;

    const char* j1 = "{\"arr\":[{\"id\":\"c\",\"v\":3}]}";
    const char* j2 = "{\"arr\":[{\"v\":3,\"id\":\"c\"}]}"; /* same element, keys swapped */
    char* r = syncer_merge_json_ex(j1, j2, &opts);
    assert(r != NULL);
    assert(strstr(r, "},{") == NULL); /* still exactly one element */
    syncer_free(r);

    /* Nested objects and arrays inside the element, also reordered. */
    const char* j3 = "{\"arr\":[{\"id\":1,\"meta\":{\"a\":1,\"b\":[1,2]},\"z\":true}]}";
    const char* j4 = "{\"arr\":[{\"z\":true,\"meta\":{\"b\":[1,2],\"a\":1},\"id\":1}]}";
    char* r2 = syncer_merge_json_ex(j3, j4, &opts);
    assert(r2 != NULL);
    assert(strstr(r2, "},{") == NULL);
    syncer_free(r2);

    /* Genuinely different elements must still be appended. */
    const char* j5 = "{\"arr\":[{\"id\":1,\"v\":1}]}";
    const char* j6 = "{\"arr\":[{\"v\":2,\"id\":1}]}";
    char* r3 = syncer_merge_json_ex(j5, j6, &opts);
    assert(r3 != NULL);
    assert(strstr(r3, "},{") != NULL); /* two distinct elements */
    syncer_free(r3);
}

static void test_union_dedup_semantics(void) {
    syncer_merge_options_t opts = syncer_default_options();
    opts.array_strategy = SYNCER_ARRAY_UNION;

    /* Array element ORDER stays significant: [1,2] != [2,1]. */
    const char* j1 = "{\"arr\":[[1,2]]}";
    const char* j2 = "{\"arr\":[[2,1]]}";
    char* r = syncer_merge_json_ex(j1, j2, &opts);
    assert(r != NULL);
    assert(strstr(r, "[[1,2],[2,1]]") != NULL);
    syncer_free(r);

    /* Key subset/superset are not equal. */
    const char* j3 = "{\"arr\":[{\"a\":1}]}";
    const char* j4 = "{\"arr\":[{\"a\":1,\"b\":2}]}";
    char* r2 = syncer_merge_json_ex(j3, j4, &opts);
    assert(r2 != NULL);
    assert(strstr(r2, "},{") != NULL);
    syncer_free(r2);

    /* Scalars, nulls and booleans dedup by value. */
    const char* j5 = "{\"arr\":[1,\"s\",null,true]}";
    const char* j6 = "{\"arr\":[true,null,\"s\",1,2]}";
    char* r3 = syncer_merge_json_ex(j5, j6, &opts);
    assert(r3 != NULL);
    assert(strstr(r3, "[1,\"s\",null,true,2]") != NULL);
    syncer_free(r3);
}

static void test_union_idempotent_after_reorder(void) {
    /* Applying the same payload twice must be a no-op even when the stored
       side has had its keys reordered in between (the jsonb round trip). */
    syncer_merge_options_t opts = syncer_default_options();
    opts.array_strategy = SYNCER_ARRAY_UNION;

    const char* stored = "{\"arr\":[{\"v\":3,\"id\":\"c\"},{\"q\":1,\"id\":\"d\"}]}";
    const char* incoming = "{\"arr\":[{\"id\":\"c\",\"v\":3},{\"id\":\"d\",\"q\":1}]}";
    char* once = syncer_merge_json_ex(stored, incoming, &opts);
    assert(once != NULL);
    char* twice = syncer_merge_json_ex(once, incoming, &opts);
    assert(twice != NULL);
    assert(strcmp(once, twice) == 0);
    /* Two elements, not four. */
    assert(strstr(once, "\"id\":\"c\"") != NULL);
    assert(strstr(once, "\"id\":\"d\"") != NULL);
    syncer_free(once);
    syncer_free(twice);
}

/* ========================================================================== */
/*  Main                                                                      */
/* ========================================================================== */

/* ========================================================================== */
/*  Test: keys containing an escaped NUL are not truncated or aliased         */
/*        (regression — found while building the libFuzzer harnesses)         */
/* ========================================================================== */

static void test_nul_in_key_not_truncated(void) {
    /* RFC 8259 permits the escape sequence for code point zero inside a string, and yyjson parses
       such keys with a length that spans the embedded byte. The engine used to
       look keys up and recreate them with strlen(), truncating there. Three
       distinct corruptions followed; all cases below must now round-trip. */

    /* 1. Copy of a v2-only key must keep its full length, not truncate. */
    char* r = syncer_merge_json("{}", "{\"a\\u0000b\":1}", NULL);
    assert(r != NULL);
    assert(strstr(r, "\"a\\u0000b\":1") != NULL);
    assert(strcmp(r, "{\"a\":1}") != 0);
    syncer_free(r);

    /* 2. Two keys sharing the prefix before the escape stay distinct instead
          of collapsing onto one truncated key. */
    r = syncer_merge_json("{\"a\\u0000b\":1}", "{\"a\\u0000c\":2}", NULL);
    assert(r != NULL);
    assert(strstr(r, "\"a\\u0000b\":1") != NULL);
    assert(strstr(r, "\"a\\u0000c\":2") != NULL);
    syncer_free(r);

    /* 3. The worst symptom: the incoming long key aliased onto the unrelated
          existing key "a", overwriting its value AND dropping the real key. */
    r = syncer_merge_json("{\"a\":1}", "{\"a\\u0000b\":2}", NULL);
    assert(r != NULL);
    assert(strstr(r, "\"a\":1") != NULL);          /* untouched */
    assert(strstr(r, "\"a\\u0000b\":2") != NULL);  /* added, not aliased */
    syncer_free(r);

    /* 4. Same key on both sides deep-merges rather than duplicating. */
    r = syncer_merge_json("{\"k\\u0000x\":{\"p\":1}}",
                          "{\"k\\u0000x\":{\"q\":2}}", NULL);
    assert(r != NULL);
    assert(strstr(r, "\"p\":1") != NULL);
    assert(strstr(r, "\"q\":2") != NULL);
    {   /* exactly one occurrence of the key in the output */
        const char* first = strstr(r, "k\\u0000x");
        assert(first != NULL);
        assert(strstr(first + 1, "k\\u0000x") == NULL);
    }
    syncer_free(r);

    /* 5. MERGE_BY_KEY identity keys are already length-correct; confirm the
          array path agrees with the object path. */
    {
        syncer_merge_options_t opts = syncer_default_options();
        opts.array_strategy = SYNCER_ARRAY_MERGE_BY_KEY;
        char* r2 = syncer_merge_json_ex(
            "{\"a\":[{\"id\":\"x\\u0000y\",\"v\":1}]}",
            "{\"a\":[{\"id\":\"x\\u0000y\",\"v\":2}]}", &opts);
        assert(r2 != NULL);
        assert(json_has_num(r2, "v", 2));
        assert(strstr(r2, "},{") == NULL); /* matched, not duplicated */
        syncer_free(r2);
    }

    /* Control: escaped NULs inside *values* were always handled correctly. */
    r = syncer_merge_json("{}", "{\"k\":\"x\\u0000y\"}", NULL);
    assert(r != NULL);
    assert(strstr(r, "\"x\\u0000y\"") != NULL);
    syncer_free(r);
}

int main(void) {
    printf("\n=== syncer.c test suite ===\n\n");

    TEST(test_flat_merge);
    TEST(test_deep_nested_merge);
    TEST(test_array_replace);
    TEST(test_array_append);
    TEST(test_array_union);
    TEST(test_array_merge_by_index);
    TEST(test_callback_receives_path);
    TEST(test_max_depth);
    TEST(test_extreme_depth);
    TEST(test_mixed_types);
    TEST(test_null_inputs);
    TEST(test_invalid_json);
    TEST(test_legacy_api);
    TEST(test_circular_ref_detection);
    TEST(test_crdt_timestamp_resolution);
    TEST(test_crdt_string_timestamps);
    TEST(test_crdt_mixed_int_string_timestamps);
    TEST(test_crdt_long_key_list);
    TEST(test_crdt_keys_with_spaces);
    TEST(test_crdt_equal_timestamps_merge);
    TEST(test_one_sided_null_validates);
    TEST(test_callback_bad_json_falls_back);
    TEST(test_union_dedups_objects);
    TEST(test_max_depth_one);
    TEST(test_merge_by_key_basic);
    TEST(test_merge_by_key_lww_timestamps);
    TEST(test_merge_by_key_fww_created_at);
    TEST(test_merge_by_key_id_type_normalization);
    TEST(test_merge_by_key_custom_match_keys);
    TEST(test_merge_by_key_idempotent);
    TEST(test_merge_by_key_nested_deep_merge);
    TEST(test_merge_by_key_mixed_and_missing_ids);
    TEST(test_merge_by_key_at_root);
    TEST(test_version_string);
    TEST(test_crdt_float_timestamps);
    TEST(test_crdt_int64_extremes);
    TEST(test_unicode_and_escaped_keys);
    TEST(test_union_dedup_key_order_independent);
    TEST(test_union_dedup_semantics);
    TEST(test_union_idempotent_after_reorder);
    TEST(test_nul_in_key_not_truncated);

    printf("\n=== Results: %d/%d passed ===\n\n", tests_passed, tests_run);
    return tests_passed == tests_run ? 0 : 1;
}
