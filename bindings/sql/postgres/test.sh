#!/usr/bin/env bash
set -euo pipefail

pg_bindir="$("${PG_CONFIG:-pg_config}" --bindir)"
initdb="$pg_bindir/initdb"
pg_ctl="$pg_bindir/pg_ctl"
psql="$pg_bindir/psql"
test_root="$(mktemp -d "${TMPDIR:-/tmp}/opto-sync-pg.XXXXXX")"
data_dir="$test_root/data"
socket_dir="$test_root/socket"
port=55439
mkdir -p "$socket_dir"

cleanup() {
  if test -f "$data_dir/postmaster.pid"; then
    "$pg_ctl" -D "$data_dir" -m immediate stop >/dev/null 2>&1 || true
  fi
  rm -rf "$test_root"
}
trap cleanup EXIT

"$initdb" -D "$data_dir" -A trust -U postgres --no-locale >/dev/null
"$pg_ctl" -D "$data_dir" -o "-F -k $socket_dir -p $port" -w start >/dev/null

module_path="$(pwd)/opto_sync"
result_file="$test_root/result.txt"
"$psql" -h "$socket_dir" -p "$port" -U postgres -d postgres \
  -v ON_ERROR_STOP=1 -qAt >"$result_file" <<SQL
CREATE FUNCTION opto_sync_merge(jsonb, jsonb, jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb AS '$module_path', 'opto_sync_merge'
LANGUAGE C IMMUTABLE PARALLEL SAFE;

CREATE FUNCTION opto_sync_reconcile_jsonb_trigger()
RETURNS trigger LANGUAGE plpgsql AS \$trigger\$
DECLARE
  column_name text := TG_ARGV[0];
  options jsonb := CASE WHEN TG_NARGS = 2 THEN TG_ARGV[1]::jsonb ELSE '{}'::jsonb END;
  old_row jsonb := to_jsonb(OLD);
  new_row jsonb := to_jsonb(NEW);
  old_value jsonb;
  incoming_value jsonb;
BEGIN
  old_value := old_row -> column_name;
  incoming_value := new_row -> column_name;
  IF old_value IS NULL OR old_value = 'null'::jsonb OR
     incoming_value IS NULL OR incoming_value = 'null'::jsonb THEN
    RETURN NEW;
  END IF;
  NEW := jsonb_populate_record(
    NEW,
    jsonb_set(new_row, ARRAY[column_name],
              opto_sync_merge(old_value, incoming_value, options), false)
  );
  RETURN NEW;
END
\$trigger\$;

SELECT opto_sync_merge(
  '{"items":[{"id":"a","_sync":{"updatedAt":"0000000000200"},"v":"base"}]}'::jsonb,
  '{"items":[{"id":"a","_sync":{"updatedAt":"0000000000100"},"v":"stale"},{"id":"b","v":"new"}]}'::jsonb,
  '{"lwwKeys":"#/_sync/updatedAt"}'::jsonb
)::text;

CREATE TABLE docs(id text PRIMARY KEY, data jsonb NOT NULL);
CREATE TRIGGER docs_reconcile
BEFORE UPDATE OF data ON docs
FOR EACH ROW EXECUTE FUNCTION opto_sync_reconcile_jsonb_trigger('data');
INSERT INTO docs VALUES
  ('d1', '{"profile":{"name":"Ada"},"items":[{"id":1,"qty":1}]}');
UPDATE docs SET data =
  '{"profile":{"city":"London"},"items":[{"id":1,"qty":2},{"id":2,"qty":1}]}'
WHERE id = 'd1';
SELECT (data #>> '{profile,name}') || '|' ||
       (data #>> '{profile,city}') || '|' ||
       jsonb_array_length(data -> 'items') || '|' ||
       (data #>> '{items,0,qty}')
FROM docs WHERE id = 'd1';
SQL

first="$(sed -n '1p' "$result_file")"
second="$(sed -n '2p' "$result_file")"
test "${first#*\"v\": \"base\"}" != "$first"
test "${first#*\"v\": \"new\"}" != "$first"
test "${first#*\"v\": \"stale\"}" = "$first"
test "$second" = 'Ada|London|2|2'

if "$psql" -h "$socket_dir" -p "$port" -U postgres -d postgres \
  -v ON_ERROR_STOP=1 -Atqc \
  "SELECT opto_sync_merge('{}', '{}', '{\"typo\":true}');" >/dev/null 2>&1
then
  echo "invalid options unexpectedly succeeded" >&2
  exit 1
fi

echo "PostgreSQL SQL binding tests passed"
