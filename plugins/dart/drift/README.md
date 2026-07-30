# opto_sync_drift

Transactional Drift/SQLite helpers backed by the same syncer.c engine as every
other opto-sync runtime.

```dart
final reconciler = DriftSyncer(
  Syncer('/path/to/libsyncer.so'),
);

final merged = await reconciler.reconcileJsonColumn(
  database: database,
  table: 'documents',
  idColumn: 'id',
  id: 'doc-1',
  jsonColumn: 'data',
  incomingJson: '{"profile":{"city":"London"}}',
);
```

The helper opens a Drift transaction, reads the raw JSON text, merges it through
the native core, and updates the same row. Identifiers are validated before SQL
construction and values remain bound parameters. A missing row and invalid JSON
are explicit exceptions.

`DriftSyncer.merge()` provides the same policy for records already loaded in
memory. The default is `mergeByKey` on `id`, timestamp resolution on, LWW on
`updatedAt,syncedAt`, and no FWW selector.

For SQLite deployments that can load native extensions,
[`bindings/sql/sqlite`](../../../bindings/sql/sqlite) removes the FFI round trip
and lets an UPSERT call `opto_sync_merge()` directly inside SQL.
