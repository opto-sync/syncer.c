# opto-sync-seaorm

SeaORM plugin for opto-sync: CRDT-style reconciliation of `jsonb` columns,
backed by the statically linked `syncer` C core (via `syncer-rs`).

The crate is intentionally ORM-agnostic at the type level: it operates on
`&str` and `serde_json::Value` (SeaORM's `Json` column type is a re-export of
`serde_json::Value`), so it adds no heavy dependencies.

## Usage

```rust
use opto_sync_seaorm::{reconcile_jsonb, reconcile_values, ReconcileOptions};

let merged = reconcile_values(&model.data, &incoming, &ReconcileOptions::default())?;
// let mut active: document::ActiveModel = model.into();
// active.data = Set(merged);
// active.update(db).await?;
```

Defaults: Last-Write-Wins on `updatedAt,syncedAt`, no First-Write-Wins
selector, and arrays merged element-by-identity on `id` (MergeByKey).
