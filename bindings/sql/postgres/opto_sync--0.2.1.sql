CREATE FUNCTION opto_sync_merge(
  base jsonb,
  incoming jsonb,
  options jsonb DEFAULT '{}'::jsonb
)
RETURNS jsonb
AS 'MODULE_PATHNAME', 'opto_sync_merge'
LANGUAGE C
IMMUTABLE
PARALLEL SAFE;

COMMENT ON FUNCTION opto_sync_merge(jsonb, jsonb, jsonb) IS
'Reconcile two JSONB values through syncer.c. The default policy uses merge_by_key on id, LWW on updatedAt/syncedAt, and no FWW selector.';

/*
 * Generic BEFORE UPDATE trigger. The first argument is the JSONB column name;
 * the optional second argument is an opto_sync_merge options JSON object.
 *
 * Explicit SQL NULL remains a deliberate clear. Reconciliation runs only when
 * both OLD and NEW contain non-null JSON values.
 */
CREATE FUNCTION opto_sync_reconcile_jsonb_trigger()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  column_name text;
  options jsonb := '{}'::jsonb;
  old_row jsonb;
  new_row jsonb;
  old_value jsonb;
  incoming_value jsonb;
  merged_value jsonb;
BEGIN
  IF TG_OP <> 'UPDATE' THEN
    RAISE EXCEPTION 'opto_sync_reconcile_jsonb_trigger only supports UPDATE';
  END IF;
  IF TG_NARGS < 1 OR TG_NARGS > 2 OR TG_ARGV[0] IS NULL OR TG_ARGV[0] = '' THEN
    RAISE EXCEPTION
      'opto_sync_reconcile_jsonb_trigger requires column name and optional options JSON';
  END IF;

  column_name := TG_ARGV[0];
  IF TG_NARGS = 2 THEN
    options := TG_ARGV[1]::jsonb;
  END IF;

  old_row := to_jsonb(OLD);
  new_row := to_jsonb(NEW);
  IF NOT (new_row ? column_name) THEN
    RAISE EXCEPTION 'column "%" does not exist on %.%', column_name, TG_TABLE_SCHEMA, TG_TABLE_NAME;
  END IF;

  old_value := old_row -> column_name;
  incoming_value := new_row -> column_name;
  IF old_value IS NULL OR old_value = 'null'::jsonb OR
     incoming_value IS NULL OR incoming_value = 'null'::jsonb THEN
    RETURN NEW;
  END IF;

  merged_value := opto_sync_merge(old_value, incoming_value, options);
  NEW := jsonb_populate_record(NEW, jsonb_set(new_row, ARRAY[column_name], merged_value, false));
  RETURN NEW;
END
$$;

COMMENT ON FUNCTION opto_sync_reconcile_jsonb_trigger() IS
'BEFORE UPDATE trigger helper: TG_ARGV[0] is a JSONB column and TG_ARGV[1] is optional merge options JSON.';
