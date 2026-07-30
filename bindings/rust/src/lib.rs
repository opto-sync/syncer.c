use std::ffi::{c_char, c_void, CStr, CString};
use std::ptr;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(C)]
pub enum ArrayMergeStrategy {
    Replace = 0,
    Append = 1,
    Union = 2,
    MergeByIndex = 3,
    /// Match object elements by identity key(s) (`array_match_keys`, default
    /// `"id"`), deep-merge matched pairs (honoring timestamp resolution per
    /// element), append unmatched incoming elements, keep existing-only
    /// elements. Non-object elements get UNION (idempotent) semantics.
    MergeByKey = 4,
}

pub type MergeOverrideCbEx = extern "C" fn(
    json_path: *const c_char,
    val1: *const c_char,
    val2: *const c_char,
) -> *mut c_char;

#[repr(C)]
pub struct SyncerMergeOptionsC {
    pub override_cb: Option<MergeOverrideCbEx>,
    pub array_strategy: ArrayMergeStrategy,
    pub max_depth: u32,
    pub detect_circular_refs: bool,
    pub resolve_by_timestamp: bool,
    pub lww_keys: *const c_char,
    pub fww_keys: *const c_char,
    /// MUST remain the LAST field, mirroring `syncer_merge_options_t` in
    /// core/include/syncer.h (v0.2.0). NULL = "id".
    pub array_match_keys: *const c_char,
}

#[derive(Default)]
pub struct MergeOptions {
    pub array_strategy: Option<ArrayMergeStrategy>,
    pub max_depth: Option<u32>,
    pub detect_circular_refs: bool,
    pub resolve_by_timestamp: bool,
    pub lww_keys: Option<String>,
    pub fww_keys: Option<String>,
    /// Comma-separated identity keys for [`ArrayMergeStrategy::MergeByKey`]
    /// (e.g. `"uuid,id"`). The first listed key present in an incoming
    /// element is its identity. `None` = `"id"`.
    pub array_match_keys: Option<String>,
}

extern "C" {
    pub fn syncer_merge_json(
        json1: *const c_char,
        json2: *const c_char,
        cb: *const c_void,
    ) -> *mut c_char;

    pub fn syncer_merge_json_ex(
        json1: *const c_char,
        json2: *const c_char,
        opts: *const SyncerMergeOptionsC,
    ) -> *mut c_char;

    pub fn syncer_free(ptr: *mut c_void);

    pub fn syncer_version() -> *const c_char;
}

/// Version of the statically linked C core as `"major.minor.patch"`.
///
/// The C string is static and never freed.
pub fn version() -> &'static str {
    unsafe {
        // The core guarantees a static, NUL-terminated ASCII string.
        CStr::from_ptr(syncer_version())
            .to_str()
            .expect("syncer_version() returned non-UTF-8")
    }
}

pub fn merge_json(json1: &str, json2: &str) -> String {
    merge_json_with_options(json1, json2, &MergeOptions::default())
}

/// Like [`merge_json_with_options`], but distinguishes failure (`None`) from
/// success instead of collapsing errors into an empty string. Fails when an
/// input contains an interior NUL byte or is not valid JSON.
pub fn try_merge_json_with_options(
    json1: &str,
    json2: &str,
    opts: &MergeOptions,
) -> Option<String> {
    // ok()? instead of unwrap(): an interior NUL in caller data must surface
    // as a failed merge, not a panic across the FFI wrapper.
    let c_json1 = CString::new(json1).ok()?;
    let c_json2 = CString::new(json2).ok()?;

    let lww_keys_cstr = match opts.lww_keys.as_ref() {
        Some(s) => Some(CString::new(s.as_str()).ok()?),
        None => None,
    };
    let fww_keys_cstr = match opts.fww_keys.as_ref() {
        Some(s) => Some(CString::new(s.as_str()).ok()?),
        None => None,
    };
    let array_match_keys_cstr = match opts.array_match_keys.as_ref() {
        Some(s) => Some(CString::new(s.as_str()).ok()?),
        None => None,
    };

    let c_opts = SyncerMergeOptionsC {
        override_cb: None,
        array_strategy: opts
            .array_strategy
            .as_ref()
            .copied()
            .unwrap_or(ArrayMergeStrategy::Replace),
        max_depth: opts.max_depth.unwrap_or(0),
        detect_circular_refs: opts.detect_circular_refs,
        resolve_by_timestamp: opts.resolve_by_timestamp,
        lww_keys: lww_keys_cstr.as_ref().map_or(ptr::null(), |c| c.as_ptr()),
        fww_keys: fww_keys_cstr.as_ref().map_or(ptr::null(), |c| c.as_ptr()),
        array_match_keys: array_match_keys_cstr
            .as_ref()
            .map_or(ptr::null(), |c| c.as_ptr()),
    };

    unsafe {
        let ptr = syncer_merge_json_ex(c_json1.as_ptr(), c_json2.as_ptr(), &c_opts);
        if ptr.is_null() {
            return None;
        }
        // Strict UTF-8, not `to_string_lossy`: lossy conversion would replace
        // undecodable bytes with U+FFFD and hand back a silently corrupted
        // document. Inputs are `&str` (already valid UTF-8) and JSON is
        // UTF-8 by definition, so this branch should be unreachable — report
        // it as a failure rather than fabricate a plausible-looking result.
        let res = CStr::from_ptr(ptr).to_str().map(str::to_owned).ok();
        syncer_free(ptr as *mut c_void);
        res
    }
}

pub fn merge_json_with_options(json1: &str, json2: &str, opts: &MergeOptions) -> String {
    try_merge_json_with_options(json1, json2, opts).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_merge() {
        let j1 = r#"{"a": 1, "b": {"c": 2}}"#;
        let j2 = r#"{"b": {"d": 3}, "e": 4}"#;
        let res = merge_json(j1, j2);

        assert!(res.contains("\"a\":1"));
        assert!(res.contains("\"c\":2"));
        assert!(res.contains("\"d\":3"));
        assert!(res.contains("\"e\":4"));
    }

    #[test]
    fn test_crdt() {
        let j1 = r#"{"doc": {"updatedAt": 100, "v": 1}}"#;
        let j2 = r#"{"doc": {"updatedAt": 50, "v": 2}}"#;
        let opts = MergeOptions {
            resolve_by_timestamp: true,
            ..MergeOptions::default()
        };

        let res = merge_json_with_options(j1, j2, &opts);
        assert!(res.contains("\"v\":1")); // Kept v1 because 100 > 50
    }

    #[test]
    fn test_interior_nul_does_not_panic() {
        let j2 = "{\"b\":\"x\u{0}y\"}"; // interior NUL byte in caller data
        assert_eq!(merge_json("{\"a\":1}", j2), "");
        assert_eq!(
            try_merge_json_with_options("{\"a\":1}", j2, &MergeOptions::default()),
            None
        );
    }

    #[test]
    fn test_invalid_json_is_none() {
        assert_eq!(
            try_merge_json_with_options("{oops", "{}", &MergeOptions::default()),
            None
        );
        assert_eq!(merge_json("{oops", "{}"), "");
    }

    fn merge_by_key_opts() -> MergeOptions {
        MergeOptions {
            array_strategy: Some(ArrayMergeStrategy::MergeByKey),
            resolve_by_timestamp: true,
            lww_keys: Some("updatedAt,syncedAt".to_string()),
            fww_keys: Some("createdAt".to_string()),
            ..MergeOptions::default()
        }
    }

    #[test]
    fn test_version() {
        let v = version();
        let parts: Vec<&str> = v.split('.').collect();
        assert_eq!(parts.len(), 3, "version not major.minor.patch: {v}");
        assert!(parts.iter().all(|p| p.parse::<u32>().is_ok()), "{v}");
        assert!(v >= "0.2.0", "core too old for this binding: {v}");
    }

    #[test]
    fn test_merge_by_key_basic() {
        // id:1 exists only in base (kept), id:2 in both (deep-merged),
        // id:3 only incoming (appended).
        let j1 = r#"{"items":[{"id":1,"name":"a"},{"id":2,"name":"b","tag":"keep"}]}"#;
        let j2 = r#"{"items":[{"id":2,"name":"b2"},{"id":3,"name":"c"}]}"#;
        let mut opts = merge_by_key_opts();
        opts.resolve_by_timestamp = false;
        let res = try_merge_json_with_options(j1, j2, &opts).unwrap();
        assert!(res.contains(r#""id":1"#), "existing-only kept: {res}");
        assert!(res.contains(r#""name":"b2""#), "matched pair merged: {res}");
        assert!(
            res.contains(r#""tag":"keep""#),
            "merged, not replaced: {res}"
        );
        assert!(!res.contains(r#""name":"b""#) || res.contains(r#""name":"b2""#));
        assert!(
            res.contains(r#""id":3"#),
            "unmatched incoming appended: {res}"
        );
        // id:2 must not appear twice
        assert_eq!(res.matches(r#""id":2"#).count(), 1, "{res}");
    }

    #[test]
    fn test_merge_by_key_numeric_string_identity() {
        // Core promise: id 42 matches "42".
        let j1 = r#"{"items":[{"id":42,"v":"base"}]}"#;
        let j2 = r#"{"items":[{"id":"42","w":"inc"}]}"#;
        let mut opts = merge_by_key_opts();
        opts.resolve_by_timestamp = false;
        let res = try_merge_json_with_options(j1, j2, &opts).unwrap();
        assert_eq!(res.matches("42").count(), 1, "42/\"42\" must match: {res}");
        assert!(
            res.contains(r#""v":"base""#) && res.contains(r#""w":"inc""#),
            "{res}"
        );
    }

    #[test]
    fn test_merge_by_key_custom_match_keys() {
        // "uuid,id": uuid takes precedence as the identity key.
        let j1 = r#"{"rows":[{"uuid":"u-1","id":9,"v":1},{"id":7,"v":2}]}"#;
        let j2 = r#"{"rows":[{"uuid":"u-1","id":999,"patched":true},{"id":7,"also":true}]}"#;
        let mut opts = merge_by_key_opts();
        opts.resolve_by_timestamp = false;
        opts.array_match_keys = Some("uuid,id".to_string());
        let res = try_merge_json_with_options(j1, j2, &opts).unwrap();
        // u-1 matched by uuid despite differing id; id:7 matched by id fallback.
        assert_eq!(res.matches("u-1").count(), 1, "{res}");
        assert!(res.contains(r#""patched":true"#), "{res}");
        assert_eq!(res.matches(r#""id":7"#).count(), 1, "{res}");
        assert!(res.contains(r#""also":true"#), "{res}");
    }

    #[test]
    fn test_merge_by_key_per_element_lww_reordered() {
        // Arrays deliberately reordered: matching is by id, not index.
        // id:1 incoming is stale (updatedAt 50 < 100) -> rejected.
        // id:2 incoming is fresh (updatedAt 300 > 200) -> merged.
        let j1 =
            r#"{"items":[{"id":1,"updatedAt":100,"v":"keep"},{"id":2,"updatedAt":200,"v":"old"}]}"#;
        let j2 =
            r#"{"items":[{"id":2,"updatedAt":300,"v":"new"},{"id":1,"updatedAt":50,"v":"stale"}]}"#;
        let res = try_merge_json_with_options(j1, j2, &merge_by_key_opts()).unwrap();
        assert!(
            res.contains(r#""v":"keep""#),
            "stale incoming must lose: {res}"
        );
        assert!(!res.contains("stale"), "{res}");
        assert!(
            res.contains(r#""v":"new""#),
            "fresh incoming must win: {res}"
        );
        assert!(!res.contains(r#""v":"old""#), "{res}");
    }

    #[test]
    fn test_merge_by_key_fww_created_at() {
        // FWW on createdAt: an incoming element with a *newer* createdAt is a
        // re-creation and must be rejected in favor of the first write.
        let j1 = r#"{"items":[{"id":1,"createdAt":100,"v":"first"}]}"#;
        let j2 = r#"{"items":[{"id":1,"createdAt":900,"v":"recreated"}]}"#;
        let res = try_merge_json_with_options(j1, j2, &merge_by_key_opts()).unwrap();
        assert!(res.contains(r#""v":"first""#), "{res}");
        assert!(!res.contains("recreated"), "{res}");
    }

    #[test]
    fn test_merge_by_key_idempotent() {
        // merge(merge(a,b), b) == merge(a,b), including non-object elements
        // (UNION semantics) and object elements (key match, no duplicates).
        let a = r#"{"items":[{"id":1,"updatedAt":100,"v":1},"x",1],"tags":["a","b"]}"#;
        let b = r#"{"items":[{"id":2,"updatedAt":50,"v":2},"y","x"],"tags":["b","c"]}"#;
        let opts = merge_by_key_opts();
        let once = try_merge_json_with_options(a, b, &opts).unwrap();
        let twice = try_merge_json_with_options(&once, b, &opts).unwrap();
        assert_eq!(once, twice, "MergeByKey must be idempotent");
    }

    #[test]
    fn test_crdt_numeric_string_timestamps() {
        // Regression: strcmp would rank "9" above "10" and adopt the stale write.
        let j1 = r#"{"updatedAt":"10","val":"base"}"#;
        let j2 = r#"{"updatedAt":"9","val":"stale"}"#;
        let opts = MergeOptions {
            resolve_by_timestamp: true,
            lww_keys: Some("updatedAt".to_string()),
            ..MergeOptions::default()
        };
        let res = merge_json_with_options(j1, j2, &opts);
        assert!(
            res.contains("\"val\":\"base\""),
            "older \"9\" must not beat \"10\": {res}"
        );
    }
}
