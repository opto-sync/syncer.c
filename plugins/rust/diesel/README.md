# opto-sync-diesel

Diesel plugin for opto-sync: CRDT-style reconciliation of Postgres `jsonb`
columns, backed by the statically linked `syncer` C core (via `syncer-rs`).

The crate is intentionally ORM-agnostic at the type level: it operates on
`&str` and `serde_json::Value`, which is exactly what Diesel's `serde_json`
feature maps `jsonb` columns to, so it adds no heavy dependencies.

## Usage

```rust
use opto_sync_diesel::{reconcile_jsonb, reconcile_values, ReconcileOptions};

// Raw JSON strings:
let merged = reconcile_jsonb(&current, &incoming, &ReconcileOptions::default())?;

// Or serde_json::Value (Diesel's jsonb mapping) in a read-modify-write:
let merged = reconcile_values(&current_value, &incoming_value, &ReconcileOptions::default())?;
// diesel::update(...).set(documents::data.eq(merged)).execute(conn)?;
```

Defaults: Last-Write-Wins on `updatedAt,syncedAt`, First-Write-Wins on
`createdAt`, arrays merged element-by-identity on `id` (MergeByKey).
