use std::ffi::{c_char, c_void, CStr, CString};
use std::ptr;

#[derive(Clone, Copy)]
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
        array_strategy: opts.array_strategy.as_ref().copied().unwrap_or(ArrayMergeStrategy::Replace),
        max_depth: opts.max_depth.unwrap_or(0),
        detect_circular_refs: opts.detect_circular_refs,
        resolve_by_timestamp: opts.resolve_by_timestamp,
        lww_keys: lww_keys_cstr.as_ref().map_or(ptr::null(), |c| c.as_ptr()),
        fww_keys: fww_keys_cstr.as_ref().map_or(ptr::null(), |c| c.as_ptr()),
    };

    unsafe {
        let ptr = syncer_merge_json_ex(c_json1.as_ptr(), c_json2.as_ptr(), &c_opts);
        if ptr.is_null() {
            return None;
        }
        let res = CStr::from_ptr(ptr).to_string_lossy().into_owned();
        syncer_free(ptr as *mut c_void);
        Some(res)
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
        let mut opts = MergeOptions::default();
        opts.resolve_by_timestamp = true;

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

    #[test]
    fn test_crdt_numeric_string_timestamps() {
        // Regression: strcmp would rank "9" above "10" and adopt the stale write.
        let j1 = r#"{"updatedAt":"10","val":"base"}"#;
        let j2 = r#"{"updatedAt":"9","val":"stale"}"#;
        let mut opts = MergeOptions::default();
        opts.resolve_by_timestamp = true;
        opts.lww_keys = Some("updatedAt".to_string());
        let res = merge_json_with_options(j1, j2, &opts);
        assert!(
            res.contains("\"val\":\"base\""),
            "older \"9\" must not beat \"10\": {res}"
        );
    }
}
