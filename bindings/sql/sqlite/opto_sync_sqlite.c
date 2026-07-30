#include <stddef.h>
#include <string.h>

#include <sqlite3ext.h>
SQLITE_EXTENSION_INIT1

#include "../common/options.h"

static void opto_sync_merge_sqlite(sqlite3_context* context,
                                   int argc,
                                   sqlite3_value** argv) {
    const char* base = NULL;
    const char* incoming = NULL;
    const char* options_json = NULL;

    if (sqlite3_value_type(argv[0]) != SQLITE_NULL) {
        base = (const char*)sqlite3_value_text(argv[0]);
        if (!base) {
            sqlite3_result_error_nomem(context);
            return;
        }
        if ((size_t)sqlite3_value_bytes(argv[0]) != strlen(base)) {
            sqlite3_result_error(context, "opto_sync_merge: base contains a NUL byte", -1);
            return;
        }
    }
    if (sqlite3_value_type(argv[1]) != SQLITE_NULL) {
        incoming = (const char*)sqlite3_value_text(argv[1]);
        if (!incoming) {
            sqlite3_result_error_nomem(context);
            return;
        }
        if ((size_t)sqlite3_value_bytes(argv[1]) != strlen(incoming)) {
            sqlite3_result_error(context, "opto_sync_merge: incoming contains a NUL byte", -1);
            return;
        }
    }
    if (argc == 3 && sqlite3_value_type(argv[2]) != SQLITE_NULL) {
        options_json = (const char*)sqlite3_value_text(argv[2]);
        if (!options_json) {
            sqlite3_result_error_nomem(context);
            return;
        }
        if ((size_t)sqlite3_value_bytes(argv[2]) != strlen(options_json)) {
            sqlite3_result_error(context, "opto_sync_merge: options contain a NUL byte", -1);
            return;
        }
    }

    opto_sync_sql_options_t parsed;
    char error[256];
    if (!opto_sync_sql_options_parse(options_json, &parsed, error, sizeof(error))) {
        sqlite3_result_error(context, error, -1);
        return;
    }

    char* merged = syncer_merge_json_ex(base, incoming, &parsed.value);
    opto_sync_sql_options_destroy(&parsed);
    if (!merged) {
        sqlite3_result_error(context,
                             "opto_sync_merge: input is not valid JSON or allocation failed", -1);
        return;
    }
    sqlite3_result_text(context, merged, -1, syncer_free);
}

static int register_functions(sqlite3* database, char** error_message) {
    int flags = SQLITE_UTF8 | SQLITE_DETERMINISTIC | SQLITE_INNOCUOUS;
    int rc = sqlite3_create_function(database, "opto_sync_merge", 2, flags, NULL,
                                     opto_sync_merge_sqlite, NULL, NULL);
    if (rc == SQLITE_OK) {
        rc = sqlite3_create_function(database, "opto_sync_merge", 3, flags, NULL,
                                     opto_sync_merge_sqlite, NULL, NULL);
    }
    if (rc != SQLITE_OK && error_message) {
        *error_message = sqlite3_mprintf("opto-sync: could not register SQL functions: %s",
                                        sqlite3_errmsg(database));
    }
    return rc;
}

#ifdef _WIN32
__declspec(dllexport)
#endif
int sqlite3_optosync_init(sqlite3* database,
                          char** error_message,
                          const sqlite3_api_routines* api) {
    SQLITE_EXTENSION_INIT2(api);
    return register_functions(database, error_message);
}

/* The conventional entry point lets `.load ./opto_sync` work without naming
 * sqlite3_optosync_init explicitly. */
#ifdef _WIN32
__declspec(dllexport)
#endif
int sqlite3_extension_init(sqlite3* database,
                           char** error_message,
                           const sqlite3_api_routines* api) {
    SQLITE_EXTENSION_INIT2(api);
    return register_functions(database, error_message);
}
