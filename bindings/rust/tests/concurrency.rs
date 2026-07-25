//! Concurrency tests for the syncer Rust binding.
//!
//! The C core is stateless for the `syncer_merge_json_ex` path; the single
//! `__thread` thread-local in the core belongs to the legacy
//! `syncer_merge_json` callback API. These tests verify that (a) many
//! threads hammering `merge_json_with_options` on shared inputs always
//! produce the single-threaded expected output, and (b) the legacy
//! callback-free path and the extended path do not interfere across
//! threads.
//!
//! Run with: cargo test

use std::ffi::{c_void, CStr, CString};
use std::ptr;
use std::thread;

use syncer_rs::{
    merge_json, syncer_free, syncer_merge_json, try_merge_json_with_options, ArrayMergeStrategy,
    MergeOptions,
};

/// Call the LEGACY C entry point `syncer_merge_json` with a NULL callback.
/// This is the only code path in the core that touches its single
/// `__thread` thread-local (the legacy callback slot).
fn legacy_merge(j1: &str, j2: &str) -> String {
    let c1 = CString::new(j1).expect("interior NUL");
    let c2 = CString::new(j2).expect("interior NUL");
    unsafe {
        let p = syncer_merge_json(c1.as_ptr(), c2.as_ptr(), ptr::null());
        assert!(!p.is_null(), "legacy merge returned NULL");
        let s = CStr::from_ptr(p).to_string_lossy().into_owned();
        syncer_free(p as *mut c_void);
        s
    }
}

fn conc_opts() -> MergeOptions {
    MergeOptions {
        array_strategy: Some(ArrayMergeStrategy::MergeByKey),
        resolve_by_timestamp: true,
        lww_keys: Some("updatedAt,syncedAt".to_string()),
        fww_keys: Some("createdAt".to_string()),
        array_match_keys: Some("uuid,id".to_string()),
        ..MergeOptions::default()
    }
}

const BASE: &str = r#"{
    "items": [
        {"id": 1, "updatedAt": 100, "v": "keep", "tag": "base-only"},
        {"id": 2, "updatedAt": 200, "v": "old"},
        {"uuid": "u-9", "id": 9, "createdAt": 10, "v": "first"}
    ],
    "meta": {"updatedAt": 500, "owner": "base"},
    "tags": ["a", "b"]
}"#;

const INCOMING: &str = r#"{
    "items": [
        {"id": 2, "updatedAt": 300, "v": "new"},
        {"id": 1, "updatedAt": 50, "v": "stale"},
        {"uuid": "u-9", "createdAt": 900, "v": "recreated"},
        {"id": 3, "v": "appended"}
    ],
    "meta": {"updatedAt": 400, "owner": "stale-writer"},
    "tags": ["b", "c"]
}"#;

/// 16 threads x 500 merges with the full option surface (mergeByKey +
/// timestamp resolution + lww/fww + custom match keys); every output must
/// be byte-identical to the single-thread reference result.
#[test]
fn concurrent_merge_with_options_is_deterministic() {
    let opts = conc_opts();
    let expected =
        try_merge_json_with_options(BASE, INCOMING, &opts).expect("reference merge failed");

    // Sanity: the reference actually exercised the option paths.
    for want in [r#""v":"keep""#, r#""v":"new""#, r#""v":"first""#, r#""v":"appended""#, r#""owner":"base""#] {
        assert!(expected.contains(want), "reference missing {want}: {expected}");
    }
    assert!(!expected.contains("stale") && !expected.contains("recreated"), "{expected}");

    const THREADS: usize = 16;
    const ITERS: usize = 500;

    let handles: Vec<_> = (0..THREADS)
        .map(|t| {
            let expected = expected.clone();
            thread::spawn(move || {
                let opts = conc_opts();
                for i in 0..ITERS {
                    let got = try_merge_json_with_options(BASE, INCOMING, &opts)
                        .unwrap_or_else(|| panic!("thread {t} iter {i}: merge returned None"));
                    assert_eq!(got, expected, "thread {t} iter {i}: result diverged");
                }
            })
        })
        .collect();

    for h in handles {
        h.join().expect("worker thread panicked");
    }
}

/// Different option sets running simultaneously on different threads must
/// never bleed into each other (the options struct is per-call, by value).
#[test]
fn concurrent_mixed_workloads_do_not_interfere() {
    const ITERS: usize = 500;

    let workloads: Vec<(&str, &str, MergeOptions)> = vec![
        (BASE, INCOMING, conc_opts()),
        (r#"{"a":[1,2],"b":1}"#, r#"{"a":[3],"c":2}"#, MergeOptions::default()),
        (
            r#"{"a":["x","y"]}"#,
            r#"{"a":["y","z"]}"#,
            MergeOptions {
                array_strategy: Some(ArrayMergeStrategy::Union),
                ..MergeOptions::default()
            },
        ),
        (
            r#"{"updatedAt":"10","val":"base"}"#,
            r#"{"updatedAt":"9","val":"stale"}"#,
            MergeOptions {
                resolve_by_timestamp: true,
                lww_keys: Some("updatedAt".to_string()),
                ..MergeOptions::default()
            },
        ),
    ];

    let handles: Vec<_> = workloads
        .into_iter()
        .enumerate()
        .flat_map(|(w, (j1, j2, opts))| {
            let expected = try_merge_json_with_options(j1, j2, &opts)
                .unwrap_or_else(|| panic!("workload {w}: reference merge failed"));
            // 4 threads per workload = 16 threads total.
            (0..4).map(move |t| {
                let expected = expected.clone();
                let opts = MergeOptions {
                    array_strategy: opts.array_strategy,
                    max_depth: opts.max_depth,
                    detect_circular_refs: opts.detect_circular_refs,
                    resolve_by_timestamp: opts.resolve_by_timestamp,
                    lww_keys: opts.lww_keys.clone(),
                    fww_keys: opts.fww_keys.clone(),
                    array_match_keys: opts.array_match_keys.clone(),
                };
                thread::spawn(move || {
                    for i in 0..ITERS {
                        let got = try_merge_json_with_options(j1, j2, &opts)
                            .unwrap_or_else(|| panic!("workload {w} thread {t} iter {i}: None"));
                        assert_eq!(got, expected, "workload {w} thread {t} iter {i}");
                    }
                })
            })
        })
        .collect();

    for h in handles {
        h.join().expect("worker thread panicked");
    }
}

/// Hammer the legacy callback-free path (raw `syncer_merge_json` with a
/// NULL callback — the only path that touches the core's `__thread`
/// callback slot) on half the threads while the other half uses
/// `merge_json` / the extended options path. The thread-local must never
/// make one path corrupt the other's results.
#[test]
fn legacy_path_and_ex_path_do_not_interfere() {
    const THREADS_PER_PATH: usize = 8;
    const ITERS: usize = 500;

    let legacy_j1 = r#"{"a": 1, "b": {"c": 2}}"#;
    let legacy_j2 = r#"{"b": {"d": 3}, "e": 4}"#;
    let legacy_expected = legacy_merge(legacy_j1, legacy_j2);
    assert!(!legacy_expected.is_empty(), "legacy reference merge failed");
    // The legacy path and the safe wrapper must agree on the same inputs.
    assert_eq!(legacy_expected, merge_json(legacy_j1, legacy_j2));

    let ex_opts = conc_opts();
    let ex_expected =
        try_merge_json_with_options(BASE, INCOMING, &ex_opts).expect("ex reference merge failed");

    let mut handles = Vec::new();

    for t in 0..THREADS_PER_PATH {
        let expected = legacy_expected.clone();
        handles.push(thread::spawn(move || {
            for i in 0..ITERS {
                let got = legacy_merge(legacy_j1, legacy_j2);
                assert_eq!(got, expected, "legacy thread {t} iter {i}");
            }
        }));
    }
    for t in 0..THREADS_PER_PATH {
        let expected = ex_expected.clone();
        handles.push(thread::spawn(move || {
            let opts = conc_opts();
            for i in 0..ITERS {
                let got = try_merge_json_with_options(BASE, INCOMING, &opts)
                    .unwrap_or_else(|| panic!("ex thread {t} iter {i}: None"));
                assert_eq!(got, expected, "ex thread {t} iter {i}");
            }
        }));
    }

    for h in handles {
        h.join().expect("worker thread panicked");
    }
}
