#!/bin/sh
set -eu

package_root=${ZED_PKG_TEST_TARGET:-}
if [ -z "$package_root" ]; then
  echo "ZED_PKG_TEST_TARGET is required" >&2
  exit 64
fi

for required in \
  .zpkg.toml \
  core/include/syncer.h \
  core/src/syncer.c \
  core/src/yyjson.c; do
  if [ ! -f "$package_root/$required" ]; then
    echo "installed Zed package is missing $required" >&2
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
  -I"$package_root/core/include" \
  -I"$package_root/core/src" \
  "$work_dir/smoke.c" \
  "$package_root/core/src/syncer.c" \
  "$package_root/core/src/yyjson.c" \
  -o "$work_dir/smoke"

"$work_dir/smoke"
echo "installed opto-sync/syncer artifact passed its C consumer smoke test"
