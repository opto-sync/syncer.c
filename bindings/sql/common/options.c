#include "options.h"

#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

#if defined(__GNUC__) || defined(__clang__)
static void set_error(char* error, size_t error_size, const char* format, ...)
    __attribute__((format(printf, 3, 4)));
#endif

static void set_error(char* error, size_t error_size, const char* format, ...) {
    if (!error || error_size == 0) return;
    va_list args;
    va_start(args, format);
    (void)vsnprintf(error, error_size, format, args);
    va_end(args);
}

static void canonical_defaults(syncer_merge_options_t* options) {
    *options = syncer_default_options();
    options->array_strategy = SYNCER_ARRAY_MERGE_BY_KEY;
    options->resolve_by_timestamp = true;
    options->lww_keys = "updatedAt,syncedAt";
    options->fww_keys = NULL;
    options->array_match_keys = "id";
}

static bool key_is(const yyjson_val* key, const char* camel, const char* snake) {
    const char* text = yyjson_get_str(key);
    size_t len = yyjson_get_len(key);
    return (strlen(camel) == len && memcmp(text, camel, len) == 0) ||
           (strlen(snake) == len && memcmp(text, snake, len) == 0);
}

static bool option_string(yyjson_val* value,
                          const char* name,
                          const char** output,
                          char* error,
                          size_t error_size) {
    if (yyjson_is_null(value)) {
        *output = NULL;
        return true;
    }
    if (!yyjson_is_str(value)) {
        set_error(error, error_size, "option \"%s\" must be a string or null", name);
        return false;
    }
    const char* text = yyjson_get_str(value);
    if (strlen(text) != yyjson_get_len(value)) {
        set_error(error, error_size, "option \"%s\" may not contain a NUL byte", name);
        return false;
    }
    *output = text;
    return true;
}

static bool option_bool(yyjson_val* value,
                        const char* name,
                        bool* output,
                        char* error,
                        size_t error_size) {
    if (!yyjson_is_bool(value)) {
        set_error(error, error_size, "option \"%s\" must be a boolean", name);
        return false;
    }
    *output = yyjson_get_bool(value);
    return true;
}

static bool option_strategy(yyjson_val* value,
                            syncer_array_strategy_t* output,
                            char* error,
                            size_t error_size) {
    if (yyjson_is_uint(value)) {
        uint64_t raw = yyjson_get_uint(value);
        if (raw <= (uint64_t)SYNCER_ARRAY_MERGE_BY_KEY) {
            *output = (syncer_array_strategy_t)raw;
            return true;
        }
    } else if (yyjson_is_str(value)) {
        const char* raw = yyjson_get_str(value);
        struct {
            const char* name;
            syncer_array_strategy_t value;
        } strategies[] = {
            {"replace", SYNCER_ARRAY_REPLACE},
            {"append", SYNCER_ARRAY_APPEND},
            {"union", SYNCER_ARRAY_UNION},
            {"merge_by_index", SYNCER_ARRAY_MERGE_BY_INDEX},
            {"mergeByIndex", SYNCER_ARRAY_MERGE_BY_INDEX},
            {"merge_by_key", SYNCER_ARRAY_MERGE_BY_KEY},
            {"mergeByKey", SYNCER_ARRAY_MERGE_BY_KEY},
        };
        for (size_t i = 0; i < sizeof(strategies) / sizeof(strategies[0]); i++) {
            if (strcmp(raw, strategies[i].name) == 0) {
                *output = strategies[i].value;
                return true;
            }
        }
    }
    set_error(error, error_size,
              "option \"arrayStrategy\" must be 0..4 or one of "
              "replace, append, union, merge_by_index, merge_by_key");
    return false;
}

bool opto_sync_sql_options_parse(const char* json,
                                 opto_sync_sql_options_t* parsed,
                                 char* error,
                                 size_t error_size) {
    if (!parsed) {
        set_error(error, error_size, "internal error: parsed options output is null");
        return false;
    }
    parsed->document = NULL;
    canonical_defaults(&parsed->value);
    if (!json || json[0] == '\0') return true;

    parsed->document = yyjson_read(json, strlen(json), 0);
    if (!parsed->document) {
        set_error(error, error_size, "options must be valid JSON");
        return false;
    }
    yyjson_val* root = yyjson_doc_get_root(parsed->document);
    if (!yyjson_is_obj(root)) {
        set_error(error, error_size, "options must be a JSON object");
        opto_sync_sql_options_destroy(parsed);
        return false;
    }

    yyjson_obj_iter iterator;
    yyjson_obj_iter_init(root, &iterator);
    yyjson_val* key;
    while ((key = yyjson_obj_iter_next(&iterator))) {
        yyjson_val* value = yyjson_obj_iter_get_val(key);
        if (key_is(key, "arrayStrategy", "array_strategy")) {
            if (!option_strategy(value, &parsed->value.array_strategy, error, error_size))
                goto fail;
        } else if (key_is(key, "arrayMatchKeys", "array_match_keys")) {
            if (!option_string(value, "arrayMatchKeys", &parsed->value.array_match_keys,
                               error, error_size))
                goto fail;
        } else if (key_is(key, "resolveByTimestamp", "resolve_by_timestamp")) {
            if (!option_bool(value, "resolveByTimestamp",
                             &parsed->value.resolve_by_timestamp, error, error_size))
                goto fail;
        } else if (key_is(key, "lwwKeys", "lww_keys")) {
            if (!option_string(value, "lwwKeys", &parsed->value.lww_keys,
                               error, error_size))
                goto fail;
        } else if (key_is(key, "fwwKeys", "fww_keys")) {
            if (!option_string(value, "fwwKeys", &parsed->value.fww_keys,
                               error, error_size))
                goto fail;
        } else if (key_is(key, "maxDepth", "max_depth")) {
            if (!yyjson_is_uint(value) || yyjson_get_uint(value) > UINT32_MAX) {
                set_error(error, error_size,
                          "option \"maxDepth\" must be an integer from 0 to %u",
                          UINT32_MAX);
                goto fail;
            }
            parsed->value.max_depth = (uint32_t)yyjson_get_uint(value);
        } else if (key_is(key, "detectCircularRefs", "detect_circular_refs")) {
            if (!option_bool(value, "detectCircularRefs",
                             &parsed->value.detect_circular_refs, error, error_size))
                goto fail;
        } else {
            set_error(error, error_size, "unknown option \"%.*s\"",
                      (int)yyjson_get_len(key), yyjson_get_str(key));
            goto fail;
        }
    }
    return true;

fail:
    opto_sync_sql_options_destroy(parsed);
    return false;
}

void opto_sync_sql_options_destroy(opto_sync_sql_options_t* parsed) {
    if (!parsed) return;
    if (parsed->document) yyjson_doc_free(parsed->document);
    parsed->document = NULL;
}
