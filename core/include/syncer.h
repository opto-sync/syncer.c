#ifndef SYNCER_H
#define SYNCER_H

#ifdef __cplusplus
extern "C" {
#endif

#include <stddef.h>
#include <stdint.h>
#include <stdbool.h>

/* --------------------------------------------------------------------------
 * Array merge strategies
 * -------------------------------------------------------------------------- */
typedef enum {
    SYNCER_ARRAY_REPLACE = 0,      /* v2 array completely replaces v1 (default) */
    SYNCER_ARRAY_APPEND,           /* concatenate v2 elements after v1 */
    SYNCER_ARRAY_UNION,            /* append only elements from v2 not already in v1 */
    SYNCER_ARRAY_MERGE_BY_INDEX,   /* merge element-wise: v1[i] deep-merged with v2[i] */
    SYNCER_ARRAY_MERGE_BY_KEY      /* match object elements by identity key(s), deep-merge
                                      matched pairs (honoring timestamp resolution), append
                                      unmatched v2 elements, keep v1-only elements.
                                      Non-object elements behave like UNION (idempotent). */
} syncer_array_strategy_t;

/* --------------------------------------------------------------------------
 * Callback typedefs
 * -------------------------------------------------------------------------- */

/**
 * Legacy callback: receives the immediate key name.
 */
typedef char* (*syncer_merge_override_cb)(const char* key,
                                          const char* val1,
                                          const char* val2);

/**
 * Extended callback: receives the full JSON path (e.g. "$.users[0].profile").
 */
typedef char* (*syncer_merge_override_cb_ex)(const char* json_path,
                                             const char* val1,
                                             const char* val2);

/* --------------------------------------------------------------------------
 * Options struct for the extended API
 * -------------------------------------------------------------------------- */
typedef struct {
    syncer_merge_override_cb_ex override_cb;   /* NULL = use default merge */
    syncer_array_strategy_t     array_strategy; /* default: SYNCER_ARRAY_REPLACE */
    uint32_t                    max_depth;      /* 0 = unlimited */
    bool                        detect_circular_refs;
    bool                        resolve_by_timestamp; /* Enable CRDT-like timestamp resolution */
    const char*                 lww_keys;             /* Comma-separated keys for Last-Write-Wins (e.g., "updatedAt,syncedAt") */
    const char*                 fww_keys;             /* Comma-separated keys for First-Write-Wins (e.g., "createdAt") */
    const char*                 array_match_keys;     /* Comma-separated identity keys for
                                                         SYNCER_ARRAY_MERGE_BY_KEY (e.g., "id,uuid").
                                                         The first listed key present in an incoming
                                                         element is its identity. NULL = "id". */
} syncer_merge_options_t;

/**
 * Helper to get a zero-initialized default options struct.
 */
static inline syncer_merge_options_t syncer_default_options(void) {
    syncer_merge_options_t opts;
    opts.override_cb = NULL;
    opts.array_strategy = SYNCER_ARRAY_REPLACE;
    opts.max_depth = 0;
    opts.detect_circular_refs = false;
    opts.resolve_by_timestamp = false;
    opts.lww_keys = NULL;
    opts.fww_keys = NULL;
    opts.array_match_keys = NULL;
    return opts;
}

/* --------------------------------------------------------------------------
 * Core API
 * -------------------------------------------------------------------------- */

/**
 * Extended deep merge with full options.
 *
 * @param json1   Base JSON string.
 * @param json2   Incoming JSON string to merge on top.
 * @param opts    Pointer to options struct. NULL = use defaults.
 * @return Heap-allocated merged JSON string. Caller must call syncer_free().
 *         Returns NULL on parse error.
 */
char* syncer_merge_json_ex(const char* json1,
                            const char* json2,
                            const syncer_merge_options_t* opts);

/**
 * Legacy deep merge (backwards compatible).
 * Equivalent to syncer_merge_json_ex with SYNCER_ARRAY_REPLACE and legacy cb.
 */
char* syncer_merge_json(const char* json1,
                         const char* json2,
                         syncer_merge_override_cb cb);

/**
 * Free memory allocated by the syncer library.
 */
void syncer_free(void* ptr);

/**
 * Library version as "major.minor.patch". Static string — do not free.
 * Lets bindings verify at load time that the shared library they found
 * supports the API surface they were compiled against.
 */
const char* syncer_version(void);

#ifdef __cplusplus
}
#endif

#endif /* SYNCER_H */
