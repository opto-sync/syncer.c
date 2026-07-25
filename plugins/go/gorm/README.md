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
        FwwKeys:            "createdAt",
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
