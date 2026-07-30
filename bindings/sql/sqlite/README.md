# SQLite SQL binding

This loadable extension exposes the C reconciliation engine inside SQLite:

```sql
.load ./opto_sync

SELECT opto_sync_merge(
  stored_json,
  incoming_json,
  '{"arrayStrategy":"merge_by_key",
    "arrayMatchKeys":"id",
    "resolveByTimestamp":true,
    "lwwKeys":"updatedAt,syncedAt,#/_sync/updatedAt"}'
);
```

The two-argument form uses the project policy: `merge_by_key` on `id`,
timestamp resolution on, LWW on `updatedAt,syncedAt`, and no FWW selector.
Options accept camelCase or snake_case names and are validated strictly.

For an atomic insert-or-reconcile, prefer an UPSERT expression:

```sql
INSERT INTO docs(id, data) VALUES (?, ?)
ON CONFLICT(id) DO UPDATE
SET data = opto_sync_merge(docs.data, excluded.data);
```

This is safer than an `AFTER UPDATE` trigger: SQLite does not support assigning
to `NEW.data` in a `BEFORE` trigger, so a trigger must issue a second `UPDATE`
and account for recursive-trigger behavior. Applications that require a
transparent trigger can instead expose a view and use an `INSTEAD OF UPDATE`
trigger over that view.

Build and test:

```sh
make
make test
```

The function is registered `SQLITE_DETERMINISTIC | SQLITE_INNOCUOUS`, rejects
embedded NUL bytes and malformed/unknown options, and returns a SQL error for
invalid JSON rather than silently writing an empty document.
