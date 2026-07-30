# PostgreSQL SQL binding

This PGXS extension exposes the C engine as an immutable SQL function:

```sql
SELECT opto_sync_merge(stored_jsonb, incoming_jsonb);

SELECT opto_sync_merge(
  stored_jsonb,
  incoming_jsonb,
  '{"lwwKeys":"updatedAt,syncedAt,#/_sync/updatedAt"}'
);
```

It also installs a generic `BEFORE UPDATE` trigger helper:

```sql
CREATE TRIGGER documents_reconcile
BEFORE UPDATE OF data ON documents
FOR EACH ROW
EXECUTE FUNCTION opto_sync_reconcile_jsonb_trigger(
  'data',
  '{"arrayStrategy":"merge_by_key","arrayMatchKeys":"id"}'
);
```

The two-argument function and trigger defaults use the canonical project
policy: `merge_by_key` on `id`, timestamp resolution on, LWW on
`updatedAt,syncedAt`, and no FWW selector. Explicit SQL `NULL` remains a
deliberate clear in the trigger.

Build with the target server's `pg_config`:

```sh
make PG_CONFIG=/path/to/pg_config
make test-local PG_CONFIG=/path/to/pg_config
sudo make install PG_CONFIG=/path/to/pg_config
psql -c 'CREATE EXTENSION opto_sync'
```

`test-local` starts an isolated temporary PostgreSQL cluster and loads the
uninstalled module by absolute path. It does not modify an existing database.

Hosted Supabase projects cannot load an arbitrary native `.so`; they can install
pure-SQL extensions or extensions already provisioned by the platform. Use the
WASM engine in a Supabase Edge Function for hosted projects, or include this
extension in a self-hosted/custom Postgres image.
