#ifndef OPTO_SYNC_SQL_OPTIONS_H
#define OPTO_SYNC_SQL_OPTIONS_H

#include <stdbool.h>
#include <stddef.h>

#include "syncer.h"
#include "yyjson.h"

/*
 * Parsed SQL options own a yyjson document whose string storage is referenced
 * by `value`. Keep the struct alive until syncer_merge_json_ex() returns.
 */
typedef struct {
    syncer_merge_options_t value;
    yyjson_doc*            document;
} opto_sync_sql_options_t;

/*
 * Parse the shared SQL options object.
 *
 * NULL, "", and "{}" select the canonical opto-sync policy:
 * MERGE_BY_KEY on "id", timestamp resolution enabled, LWW on
 * "updatedAt,syncedAt", and no FWW selector.
 *
 * On failure returns false and writes a human-readable message to error.
 */
bool opto_sync_sql_options_parse(const char* json,
                                 opto_sync_sql_options_t* parsed,
                                 char* error,
                                 size_t error_size);

void opto_sync_sql_options_destroy(opto_sync_sql_options_t* parsed);

#endif
