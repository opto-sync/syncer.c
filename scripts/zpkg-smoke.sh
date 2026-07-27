#!/bin/sh
set -eu

package_root=${1:-${ZED_PKG_TEST_TARGET:-}}
if [ -z "$package_root" ] || [ ! -d "$package_root" ]; then
  echo "usage: sh scripts/zpkg-smoke.sh <extracted-package-root>" >&2
  exit 64
fi

header=$(find "$package_root" -type f -path '*/include/syncer.h' -print | head -n 1)
source=$(find "$package_root" -type f -path '*/src/syncer.c' -print | head -n 1)
yyjson=$(find "$package_root" -type f -path '*/src/yyjson.c' -print | head -n 1)

for required in "$header" "$source" "$yyjson"; do
  if [ -z "$required" ] || [ ! -f "$required" ]; then
    echo "installed Zed artifact is missing the C core" >&2
    exit 65
  fi
done

work_dir=$(mktemp -d "${TMPDIR:-/tmp}/opto-sync-zpkg.XXXXXX")
cleanup() {
  rm -rf "$work_dir"
}
trap cleanup EXIT HUP INT TERM

cat >"$work_dir/smoke.c" <<'EOF'
#include "syncer.h"

#include <stdio.h>
#include <string.h>

int main(void) {
    const char *version = syncer_version();
    if (version == NULL || strcmp(version, "0.2.1") != 0) {
        fprintf(stderr, "unexpected syncer version: %s\n", version == NULL ? "<null>" : version);
        return 1;
    }

    char *merged = syncer_merge_json(
        "{\"value\":1,\"left\":true}",
        "{\"value\":2,\"right\":true}",
        NULL
    );
    if (merged == NULL) {
        fputs("merge returned NULL\n", stderr);
        return 2;
    }

    const int valid =
        strstr(merged, "\"value\":2") != NULL &&
        strstr(merged, "\"left\":true") != NULL &&
        strstr(merged, "\"right\":true") != NULL;
    if (!valid) {
        fprintf(stderr, "unexpected merge output: %s\n", merged);
        syncer_free(merged);
        return 3;
    }

    syncer_free(merged);
    return 0;
}
EOF

${CC:-cc} \
  -std=c99 \
  -Wall \
  -Wextra \
  -Werror \
  -I"$(dirname "$header")" \
  -I"$(dirname "$source")" \
  "$work_dir/smoke.c" \
  "$source" \
  "$yyjson" \
  -o "$work_dir/smoke"

"$work_dir/smoke"
echo "installed opto-sync C artifact passed its consumer smoke test"
