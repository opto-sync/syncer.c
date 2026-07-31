//! opto-sync reconciliation helpers for SeaORM `jsonb` workflows.
//!
//! SeaORM maps `jsonb` columns to `sea_orm::entity::prelude::Json`, which is
//! a re-export of [`serde_json::Value`]. This crate stays deliberately
//! ORM-agnostic — it operates on `&str` / `Value`, which is exactly what
//! SeaORM hands you — so it adds no heavy dependencies to your build. The
//! reconciliation itself is performed by the statically linked `syncer` C
//! core via `syncer-rs`.
//!
//! Typical SeaORM pattern:
//!
//! ```ignore
//! use sea_orm::{ActiveModelTrait, EntityTrait, Set};
//! use opto_sync_seaorm::{reconcile_values, ReconcileOptions};
//!
//! let doc = Document::find_by_id(doc_id).one(db).await?.unwrap();
//! let merged = reconcile_values(&doc.data, &incoming, &ReconcileOptions::default())?;
//!
//! let mut active: document::ActiveModel = doc.into();
//! active.data = Set(merged); // Json == serde_json::Value
//! active.update(db).await?;
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
/// `opts`.
pub fn reconcile_jsonb(
    current: &str,
    incoming: &str,
    opts: &ReconcileOptions,
) -> Result<String, ReconcileError> {
    try_merge_json_with_options(current, incoming, &opts.to_merge_options())
        .ok_or(ReconcileError::InvalidJson)
}

/// Reconcile two [`serde_json::Value`]s (SeaORM's `Json` column type).
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
    fn lww_prefers_newest_per_nested_object() {
        let current = json!({"doc": {"updatedAt": 300, "body": "kept"}});
        let incoming = json!({"doc": {"updatedAt": 200, "body": "stale"}});
        let merged = reconcile_values(&current, &incoming, &ReconcileOptions::default()).unwrap();
        assert_eq!(merged["doc"]["body"], "kept");
    }

    #[test]
    fn merge_by_key_appends_and_keeps() {
        let current = r#"{"rows":[{"id":1,"v":"a"}]}"#;
        let incoming = r#"{"rows":[{"id":2,"v":"b"}]}"#;
        let res = reconcile_jsonb(current, incoming, &ReconcileOptions::default()).unwrap();
        assert!(
            res.contains(r#""id":1"#) && res.contains(r#""id":2"#),
            "{res}"
        );
    }

    #[test]
    fn custom_match_keys_are_honored() {
        let opts = ReconcileOptions {
            array_match_keys: "uuid,id".to_string(),
            ..ReconcileOptions::default()
        };
        let current = json!({"rows":[{"uuid":"u1","id":1,"v":"a"}]});
        let incoming = json!({"rows":[{"uuid":"u1","id":999,"v":"b"}]});
        let merged = reconcile_values(&current, &incoming, &opts).unwrap();
        assert_eq!(merged["rows"].as_array().unwrap().len(), 1);
        assert_eq!(merged["rows"][0]["v"], "b");
    }

    #[test]
    fn invalid_json_is_an_error() {
        assert_eq!(
            reconcile_jsonb("{", "{}", &ReconcileOptions::default()),
            Err(ReconcileError::InvalidJson)
        );
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
        let merged =
            reconcile_values(&current, &incoming, &ReconcileOptions::default()).unwrap();
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
}
