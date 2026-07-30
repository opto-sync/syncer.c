#include "options.h"

#include <assert.h>
#include <stdio.h>
#include <string.h>

int main(void) {
    char error[256];
    opto_sync_sql_options_t parsed;

    assert(opto_sync_sql_options_parse(NULL, &parsed, error, sizeof(error)));
    assert(parsed.value.array_strategy == SYNCER_ARRAY_MERGE_BY_KEY);
    assert(parsed.value.resolve_by_timestamp);
    assert(strcmp(parsed.value.lww_keys, "updatedAt,syncedAt") == 0);
    assert(parsed.value.fww_keys == NULL);
    opto_sync_sql_options_destroy(&parsed);

    assert(opto_sync_sql_options_parse(
        "{\"array_strategy\":\"union\",\"resolveByTimestamp\":false,"
        "\"lwwKeys\":\"#/_sync/updatedAt\",\"fww_keys\":\"createdAt\","
        "\"maxDepth\":7,\"detect_circular_refs\":true}",
        &parsed, error, sizeof(error)));
    assert(parsed.value.array_strategy == SYNCER_ARRAY_UNION);
    assert(!parsed.value.resolve_by_timestamp);
    assert(strcmp(parsed.value.lww_keys, "#/_sync/updatedAt") == 0);
    assert(strcmp(parsed.value.fww_keys, "createdAt") == 0);
    assert(parsed.value.max_depth == 7);
    assert(parsed.value.detect_circular_refs);
    opto_sync_sql_options_destroy(&parsed);

    assert(!opto_sync_sql_options_parse(
        "{\"arrayStrategy\":99}", &parsed, error, sizeof(error)));
    assert(strstr(error, "arrayStrategy") != NULL);
    assert(!opto_sync_sql_options_parse(
        "{\"typo\":true}", &parsed, error, sizeof(error)));
    assert(strstr(error, "unknown option") != NULL);

    puts("SQL options tests passed");
    return 0;
}
