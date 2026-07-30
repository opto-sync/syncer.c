# syncer-gorm

GORM plugin for opto-sync. Intercepts map-based `Updates()` on JSON/JSONB
columns, fetches the stored document, deep-merges the incoming value on top
of it via the [syncer-go](../../../bindings/go) cgo binding (syncer.c core),
and writes the merged document instead of overwriting.

## Usage

```go
import (
    syncer "github.com/opto-sync/syncer-go"
    syncer_gorm "github.com/opto-sync/syncer-gorm"
)

db.Use(&syncer_gorm.SyncerPlugin{
    Options: syncer.Options{
        ArrayStrategy:      syncer.ArrayMergeByKey,
        ResolveByTimestamp: true,
        LwwKeys:            "updatedAt,syncedAt",
    },
    // Columns: []string{"data"}, // optional; default: all fields with type json/jsonb
})

// This now deep-merges into the stored `data` document:
db.Model(&Doc{ID: "doc-1"}).Updates(map[string]any{"data": `{"nested":{"x":1}}`})
```

## Notes

- Only map-based updates are merged. Struct-based updates pass through
  unchanged (GORM omits zero fields there, so "unset" and "overwrite"
  cannot be distinguished).
- The current value is fetched using the statement's WHERE conditions
  and/or the model's primary key; unscoped updates are never merged.
- Merge errors abort the update via `db.AddError`.

## Concurrency — wrap updates in a transaction

<a id="lockingcaveat"></a>The plugin's fetch takes a `SELECT ... FOR UPDATE`
row lock on the same connection as the update it is intercepting. That makes the
read-merge-write atomic **only when the caller wraps it in a transaction**:

```go
// SAFE: the FOR UPDATE lock is held until the transaction commits.
db.Transaction(func(tx *gorm.DB) error {
    return tx.Model(&Doc{ID: id}).Updates(map[string]any{"data": incoming}).Error
})
```

Outside a transaction every statement is its own implicit transaction, so the
lock is released before the `UPDATE` runs and concurrent updates to the same row
can **lose merges**. Both behaviours are pinned by tests
(`TestConcurrentUpdatesInTransactionAreSafe` and
`TestConcurrentUpdatesLoseWrites`): with 8 concurrent writers, the transactional
form keeps all 8 merges while the bare form typically keeps only 2.

## Unscoped updates are NOT merged (guard rail, with a caveat)

With no WHERE clause and no primary key the plugin refuses to merge, rather than
merging against an arbitrary row. **But the `UPDATE` itself still proceeds** and
overwrites every matched row with the incoming document as-is — the guard rail
prevents merging the *wrong* row, it does not turn an unscoped update into an
error. Always scope your updates. Pinned by `TestUnscopedUpdateIsNotMerged`.

## Tests

The suite needs a real Postgres and uses `gorm.io/driver/postgres`. The
`syncer-go` binding compiles the C core into its cgo package, so no shared
library is required.

```bash
docker run -d --name plugintest-pg -p 127.0.0.1:55987:5432 \
  -e POSTGRES_PASSWORD=test -e POSTGRES_USER=test -e POSTGRES_DB=plugintest \
  postgres:16-alpine

go test ./... -v
docker rm -f plugintest-pg
```

Override the DSN with `OPTO_SYNC_TEST_PG`. Without a reachable Postgres the
tests **skip** rather than fail. Documents are compared as parsed values because
Postgres `jsonb` reorders object keys, and persistence is always re-read with a
plain SQL query so an in-memory-only merge cannot pass.
