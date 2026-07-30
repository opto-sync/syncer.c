/*
 * run_c.c — reference runner for the cross-language differential test.
 *
 * Usage: run_c <input.jsonl> <output.jsonl>
 *
 * Reads lines of the form {"base":<obj>,"incoming":<obj>} and writes one
 * merged JSON string per line, exactly as returned by syncer_merge_json_ex.
 *
 * Line splitting is TEXTUAL on the first occurrence of `,"incoming":` —
 * guaranteed unique per line by the corpus generator contract (no key or
 * string value contains the substring "incoming"). No re-serialization of
 * inputs or outputs anywhere.
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "syncer.h"

#define MARKER ",\"incoming\":"
#define PREFIX "{\"base\":"

int main(int argc, char** argv) {
    if (argc != 3) {
        fprintf(stderr, "usage: %s <input.jsonl> <output.jsonl>\n", argv[0]);
        return 2;
    }
    FILE* in = fopen(argv[1], "r");
    if (!in) { perror(argv[1]); return 2; }
    FILE* out = fopen(argv[2], "w");
    if (!out) { perror(argv[2]); fclose(in); return 2; }

    syncer_merge_options_t opts = syncer_default_options();
    opts.array_strategy = SYNCER_ARRAY_MERGE_BY_KEY;
    opts.resolve_by_timestamp = true;
    opts.lww_keys = "updatedAt,syncedAt,#/_sync/updatedAt";
    opts.fww_keys = "createdAt";
    opts.array_match_keys = "id";
    opts.max_depth = 0;
    opts.override_cb = NULL;
    opts.detect_circular_refs = false;

    char* line = NULL;
    size_t cap = 0;
    ssize_t len;
    long lineno = 0;
    int failures = 0;

    while ((len = getline(&line, &cap, in)) != -1) {
        lineno++;
        while (len > 0 && (line[len - 1] == '\n' || line[len - 1] == '\r'))
            line[--len] = '\0';
        if (len == 0) continue;

        if (strncmp(line, PREFIX, strlen(PREFIX)) != 0 || line[len - 1] != '}') {
            fprintf(stderr, "line %ld: malformed corpus line\n", lineno);
            failures++;
            fprintf(out, "!MALFORMED\n");
            continue;
        }
        char* marker = strstr(line, MARKER);
        if (!marker) {
            fprintf(stderr, "line %ld: marker not found\n", lineno);
            failures++;
            fprintf(out, "!MALFORMED\n");
            continue;
        }
        *marker = '\0';
        const char* base = line + strlen(PREFIX);
        char* inc = marker + strlen(MARKER);
        inc[strlen(inc) - 1] = '\0'; /* strip trailing '}' of the wrapper */

        char* merged = syncer_merge_json_ex(base, inc, &opts);
        if (!merged) {
            fprintf(stderr, "line %ld: merge returned NULL\n", lineno);
            failures++;
            fprintf(out, "!NULL\n");
            continue;
        }
        fputs(merged, out);
        fputc('\n', out);
        syncer_free(merged);
    }

    free(line);
    fclose(in);
    fclose(out);
    if (failures) {
        fprintf(stderr, "run_c: %d failures\n", failures);
        return 1;
    }
    return 0;
}
