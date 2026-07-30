#include "postgres.h"
#include "fmgr.h"
#include "utils/builtins.h"
#include "utils/errcodes.h"
#include "utils/jsonb.h"

#include "../common/options.h"

PG_MODULE_MAGIC;

PG_FUNCTION_INFO_V1(opto_sync_merge);

Datum opto_sync_merge(PG_FUNCTION_ARGS) {
    char* base_json = NULL;
    char* incoming_json = NULL;
    char* options_json = NULL;
    Datum result = (Datum)0;

    if (!PG_ARGISNULL(0)) {
        Jsonb* base = PG_GETARG_JSONB_P(0);
        base_json = JsonbToCString(NULL, &base->root, VARSIZE(base));
    }
    if (!PG_ARGISNULL(1)) {
        Jsonb* incoming = PG_GETARG_JSONB_P(1);
        incoming_json = JsonbToCString(NULL, &incoming->root, VARSIZE(incoming));
    }
    if (PG_NARGS() >= 3 && !PG_ARGISNULL(2)) {
        Jsonb* options = PG_GETARG_JSONB_P(2);
        options_json = JsonbToCString(NULL, &options->root, VARSIZE(options));
    }

    opto_sync_sql_options_t parsed;
    char error[256];
    if (!opto_sync_sql_options_parse(options_json, &parsed, error, sizeof(error))) {
        ereport(ERROR,
                (errcode(ERRCODE_INVALID_PARAMETER_VALUE),
                 errmsg("opto_sync_merge: %s", error)));
    }

    char* merged = syncer_merge_json_ex(base_json, incoming_json, &parsed.value);
    opto_sync_sql_options_destroy(&parsed);
    if (!merged) {
        ereport(ERROR,
                (errcode(ERRCODE_DATA_EXCEPTION),
                 errmsg("opto_sync_merge: merge failed"),
                 errdetail("An input was invalid JSON or the merge engine could not allocate memory.")));
    }

    /*
     * jsonb_in copies the result into PostgreSQL-managed memory. Its error path
     * longjmps, so free the core's malloc allocation in a FINALLY block too;
     * otherwise an unexpected parser error would leak backend-process memory.
     */
    PG_TRY();
    {
        result = DirectFunctionCall1(jsonb_in, CStringGetDatum(merged));
    }
    PG_FINALLY();
    {
        syncer_free(merged);
    }
    PG_END_TRY();

    PG_RETURN_DATUM(result);
}
