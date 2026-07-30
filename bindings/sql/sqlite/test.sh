#!/usr/bin/env bash
set -euo pipefail

extension="${1:?usage: test.sh /path/to/opto_sync_extension}"
sqlite="${SQLITE3:-sqlite3}"
if test -z "${SQLITE3:-}" && test -x /opt/homebrew/opt/sqlite/bin/sqlite3; then
  sqlite=/opt/homebrew/opt/sqlite/bin/sqlite3
elif test -z "${SQLITE3:-}" && test -x /usr/local/opt/sqlite/bin/sqlite3; then
  sqlite=/usr/local/opt/sqlite/bin/sqlite3
fi

result="$(
  "$sqlite" :memory: <<SQL
.bail on
.load $extension
SELECT json(opto_sync_merge(
  '{"items":[{"id":"a","_sync":{"updatedAt":"0000000000200"},"v":"base"}]}',
  '{"items":[{"id":"a","_sync":{"updatedAt":"0000000000100"},"v":"stale"},{"id":"b","v":"new"}]}',
  '{"lwwKeys":"#/_sync/updatedAt"}'
));
CREATE TABLE docs(id TEXT PRIMARY KEY, data TEXT NOT NULL CHECK(json_valid(data)));
INSERT INTO docs(id, data) VALUES
  ('d1', '{"profile":{"name":"Ada"},"items":[{"id":1,"qty":1}]}');
INSERT INTO docs(id, data) VALUES
  ('d1', '{"profile":{"city":"London"},"items":[{"id":1,"qty":2},{"id":2,"qty":1}]}')
ON CONFLICT(id) DO UPDATE SET data = opto_sync_merge(docs.data, excluded.data);
SELECT json_extract(data, '$.profile.name') || '|' ||
       json_extract(data, '$.profile.city') || '|' ||
       json_array_length(data, '$.items') || '|' ||
       json_extract(data, '$.items[0].qty')
FROM docs WHERE id = 'd1';
SQL
)"

expected_first='{"items":[{"id":"a","_sync":{"updatedAt":"0000000000200"},"v":"base"},{"id":"b","v":"new"}]}'
expected_second='Ada|London|2|2'
first="$(printf '%s\n' "$result" | sed -n '1p')"
second="$(printf '%s\n' "$result" | sed -n '2p')"

test "$first" = "$expected_first"
test "$second" = "$expected_second"

if "$sqlite" :memory: <<SQL >/dev/null 2>&1
.bail on
.load $extension
SELECT opto_sync_merge('{}', '{}', '{"arrayStrategy":"typo"}');
SQL
then
  echo "invalid options unexpectedly succeeded" >&2
  exit 1
fi

echo "SQLite SQL binding tests passed"
