//! opto-sync reconciliation helpers for sqlx `jsonb` workflows.
//!
//! sqlx decodes Postgres `jsonb` columns as [`serde_json::Value`] (via its
//! `json` feature). This crate stays deliberately ORM-agnostic — it operates
//! on `&str` / `Value`, which is exactly what sqlx hands you — so it adds no
//! heavy dependencies to your build. The reconciliation itself is performed
//! by the statically linked `syncer` C core via `syncer-rs`.
//!
//! Typical sqlx pattern (read-modify-write inside a transaction):
//!
//! ```ignore
//! use opto_sync_sqlx::{reconcile_values, ReconcileOptions};
//!
//! let mut tx = pool.begin().await?;
//! let (current,): (serde_json::Value,) =
//!     sqlx::query_as("SELECT data FROM documents WHERE id = $1 FOR UPDATE")
//!         .bind(doc_id)
//!         .fetch_one(&mut *tx)
//!         .await?;
//!
//! let merged = reconcile_values(&current, &incoming, &ReconcileOptions::default())?;
//!
//! sqlx::query("UPDATE documents SET data = $1 WHERE id = $2")
//!     .bind(&merged)
//!     .bind(doc_id)
//!     .execute(&mut *tx)
//!     .await?;
//! tx.commit().await?;
//! ```

use serde_json::Value;
use syncer_rs::{try_merge_json_with_options, ArrayMergeStrategy, MergeOptions};

/// CRDT-flavored reconciliation options.
///
/// Defaults: timestamp resolution enabled, Last-Write-Wins on
/// `updatedAt,syncedAt`, no First-Write-Wins selector, and arrays merged
/// element-by-identity on `id` ([`ArrayMergeStrategy::MergeByKey`]).
#[derive(Debug, Clone)]
pub struct ReconcileOptions {
    pub array_strategy: ArrayMergeStrategy,
    /// Comma-separated identity keys for `MergeByKey` (e.g. `"uuid,id"`).
    pub array_match_keys: String,
    pub resolve_by_timestamp: bool,
    /// Comma-separated Last-Write-Wins timestamp keys.
    pub lww_keys: String,
    /// Comma-separated First-Write-Wins timestamp keys.
    pub fww_keys: String,
    /// 0 = unlimited.
    pub max_depth: u32,
}

impl Default for ReconcileOptions {
    fn default() -> Self {
        Self {
            array_strategy: ArrayMergeStrategy::MergeByKey,
            array_match_keys: "id".to_string(),
            resolve_by_timestamp: true,
            lww_keys: "updatedAt,syncedAt".to_string(),
            fww_keys: String::new(),
            max_depth: 0,
        }
    }
}

impl ReconcileOptions {
    fn to_merge_options(&self) -> MergeOptions {
        MergeOptions {
            array_strategy: Some(self.array_strategy),
            max_depth: Some(self.max_depth),
            detect_circular_refs: false,
            resolve_by_timestamp: self.resolve_by_timestamp,
            lww_keys: Some(self.lww_keys.clone()),
            fww_keys: Some(self.fww_keys.clone()).filter(|keys| !keys.is_empty()),
            array_match_keys: Some(self.array_match_keys.clone()),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReconcileError {
    /// An input was not valid JSON (or contained an interior NUL byte).
    InvalidJson,
}

impl std::fmt::Display for ReconcileError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ReconcileError::InvalidJson => write!(f, "input is not valid JSON"),
        }
    }
}

impl std::error::Error for ReconcileError {}

/// Reconcile two `jsonb` payloads given as raw JSON strings.
///
/// `current` is the stored row state; `incoming` is the client write. The
/// returned string is the merged document, resolved with the CRDT rules in
/// `opts`. Bind it back with `$1::jsonb` or as a `serde_json::Value`.
pub fn reconcile_jsonb(
    current: &str,
    incoming: &str,
    opts: &ReconcileOptions,
) -> Result<String, ReconcileError> {
    try_merge_json_with_options(current, incoming, &opts.to_merge_options())
        .ok_or(ReconcileError::InvalidJson)
}

/// Reconcile two [`serde_json::Value`]s (sqlx's `jsonb` decoding).
pub fn reconcile_values(
    current: &Value,
    incoming: &Value,
    opts: &ReconcileOptions,
) -> Result<Value, ReconcileError> {
    let merged = reconcile_jsonb(&current.to_string(), &incoming.to_string(), opts)?;
    serde_json::from_str(&merged).map_err(|_| ReconcileError::InvalidJson)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn fresh_incoming_wins_by_lww() {
        let current = r#"{"updatedAt":100,"title":"old"}"#;
        let incoming = r#"{"updatedAt":200,"title":"new"}"#;
        let res = reconcile_jsonb(current, incoming, &ReconcileOptions::default()).unwrap();
        assert!(res.contains(r#""title":"new""#), "{res}");
    }

    #[test]
    fn default_does_not_let_created_at_veto_a_newer_write() {
        // FWW is a NODE-LEVEL veto, not field protection: an incoming node whose
        // FWW key is newer is discarded WHOLESALE, however new its updatedAt is.
        // With createdAt defaulted on, a replica holding a later createdAt could
        // never write the record again — silently, behind a 200 OK.
        assert!(
            ReconcileOptions::default().fww_keys.is_empty(),
            "the default policy must declare no fww_keys"
        );

        let current = json!({"createdAt": 100, "updatedAt": 100, "v": "base"});
        let incoming = json!({"createdAt": 200, "updatedAt": 999999, "v": "NEWEST"});
        let merged = reconcile_values(&current, &incoming, &ReconcileOptions::default()).unwrap();
        assert_eq!(merged["v"], "NEWEST", "the newest write must land by default");
        assert_eq!(merged["updatedAt"], 999999);
    }

    #[test]
    fn first_write_wins_remains_an_explicit_opt_in() {
        let current = json!({"createdAt": 100, "updatedAt": 100, "v": "base"});
        let incoming = json!({"createdAt": 200, "updatedAt": 999999, "v": "NEWEST"});
        let options = ReconcileOptions {
            fww_keys: "createdAt".to_string(),
            ..ReconcileOptions::default()
        };
        let merged = reconcile_values(&current, &incoming, &options).unwrap();
        assert_eq!(merged["v"], "base", "explicit FWW still vetoes the whole node");
        assert_eq!(
            merged["updatedAt"], 100,
            "the newest updatedAt is discarded WITH the node"
        );
    }

    #[test]
    fn merge_by_key_matches_numeric_and_string_ids() {
        let current = json!({"items":[{"id":42,"qty":1}]});
        let incoming = json!({"items":[{"id":"42","note":"same row"}]});
        let merged = reconcile_values(&current, &incoming, &ReconcileOptions::default()).unwrap();
        let items = merged["items"].as_array().unwrap();
        assert_eq!(items.len(), 1, "id 42 must match \"42\": {merged}");
        assert_eq!(merged["items"][0]["note"], "same row");
    }

    #[test]
    fn invalid_json_is_an_error() {
        assert_eq!(
            reconcile_jsonb("not json", "{}", &ReconcileOptions::default()),
            Err(ReconcileError::InvalidJson)
        );
    }
}
