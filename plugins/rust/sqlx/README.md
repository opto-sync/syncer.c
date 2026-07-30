# opto-sync-sqlx

sqlx plugin for opto-sync: CRDT-style reconciliation of Postgres `jsonb`
columns, backed by the statically linked `syncer` C core (via `syncer-rs`).

The crate is intentionally ORM-agnostic at the type level: it operates on
`&str` and `serde_json::Value`, which is exactly what sqlx's `json` feature
decodes `jsonb` columns to, so it adds no heavy dependencies.

## Usage

```rust
use opto_sync_sqlx::{reconcile_jsonb, reconcile_values, ReconcileOptions};

// Inside a transaction: SELECT ... FOR UPDATE, reconcile, UPDATE.
let merged = reconcile_values(&current_value, &incoming_value, &ReconcileOptions::default())?;
// sqlx::query("UPDATE documents SET data = $1 WHERE id = $2")
//     .bind(&merged).bind(doc_id).execute(&mut *tx).await?;
```

Defaults: Last-Write-Wins on `updatedAt,syncedAt`, no First-Write-Wins
selector, and arrays merged element-by-identity on `id` (MergeByKey).
