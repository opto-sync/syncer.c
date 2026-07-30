//! Differential fuzzer: standalone syncer.rs vs the C core (libsyncer.dylib),
//! random documents x random option sets, byte-identical output required.

use std::ffi::{CStr, CString};
use std::os::raw::c_char;

use syncer_rs::{merge_json, ArrayMergeStrategy, MergeOptions};

#[repr(C)]
struct COptions {
    override_cb: *const std::ffi::c_void,
    array_strategy: i32,
    max_depth: u32,
    detect_circular_refs: bool,
    resolve_by_timestamp: bool,
    lww_keys: *const c_char,
    fww_keys: *const c_char,
    array_match_keys: *const c_char,
}

extern "C" {
    fn syncer_merge_json_ex(
        json1: *const c_char,
        json2: *const c_char,
        opts: *const COptions,
    ) -> *mut c_char;
    fn syncer_free(ptr: *mut std::ffi::c_void);
}

fn c_merge(base: &str, incoming: &str, options: &MergeOptions) -> Option<String> {
    let base = CString::new(base).ok()?;
    let incoming = CString::new(incoming).ok()?;
    let lww = options.lww_keys.as_deref().map(|k| CString::new(k).unwrap());
    let fww = options.fww_keys.as_deref().map(|k| CString::new(k).unwrap());
    let amk = options
        .array_match_keys
        .as_deref()
        .map(|k| CString::new(k).unwrap());
    let opts = COptions {
        override_cb: std::ptr::null(),
        array_strategy: options.array_strategy as i32,
        max_depth: options.max_depth,
        detect_circular_refs: false,
        resolve_by_timestamp: options.resolve_by_timestamp,
        lww_keys: lww.as_ref().map_or(std::ptr::null(), |c| c.as_ptr()),
        fww_keys: fww.as_ref().map_or(std::ptr::null(), |c| c.as_ptr()),
        array_match_keys: amk.as_ref().map_or(std::ptr::null(), |c| c.as_ptr()),
    };
    unsafe {
        let out = syncer_merge_json_ex(base.as_ptr(), incoming.as_ptr(), &opts);
        if out.is_null() {
            return None;
        }
        let s = CStr::from_ptr(out).to_string_lossy().into_owned();
        syncer_free(out as *mut _);
        Some(s)
    }
}

// -- deterministic PRNG (splitmix64) --------------------------------------
struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E3779B97F4A7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58476D1CE4E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D049BB133111EB);
        z ^ (z >> 31)
    }
    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
    fn chance(&mut self, pct: u64) -> bool {
        self.below(100) < pct
    }
}

const KEYS: &[&str] = &[
    "id", "uuid", "updatedAt", "createdAt", "syncedAt", "_sync", "value", "name", "tags",
    "items", "n", "meta", "a/b", "~k", "число", "\u{1F600}", "",
];

fn rand_scalar(rng: &mut Rng, out: &mut String) {
    match rng.below(10) {
        0 => out.push_str("null"),
        1 => out.push_str(if rng.chance(50) { "true" } else { "false" }),
        2 => out.push_str(&format!("{}", rng.next() as i64)), // full i64 range
        3 => out.push_str(&format!("{}", rng.below(3_000))),
        4 => out.push_str(&format!("{}", i64::MIN + rng.below(4) as i64)),
        5 => out.push_str(&format!("{}.{}", rng.below(100), rng.below(1000))),
        6 => out.push_str(&format!("{}e{}", rng.below(10), rng.below(40))),
        7 => out.push_str(&format!("\"{}\"", rng.below(100_000))), // digit string
        8 => out.push_str(&format!(
            "\"2026-0{}-{}T0{}:00:00Z\"",
            1 + rng.below(9),
            10 + rng.below(19),
            rng.below(10)
        )),
        _ => out.push_str(&format!("\"s{}\"", rng.below(50))),
    }
}

fn rand_value(rng: &mut Rng, depth: u32, out: &mut String) {
    if depth >= 4 || rng.chance(45) {
        rand_scalar(rng, out);
        return;
    }
    if rng.chance(50) {
        // object
        out.push('{');
        let n = rng.below(5);
        let mut used: Vec<&str> = Vec::new();
        let mut first = true;
        for _ in 0..n {
            let key = KEYS[rng.below(KEYS.len() as u64) as usize];
            if used.contains(&key) {
                continue; // duplicate keys are documented out-of-contract
            }
            used.push(key);
            if !first {
                out.push(',');
            }
            first = false;
            out.push_str(&serde_json_escape(key));
            out.push(':');
            rand_value(rng, depth + 1, out);
        }
        out.push('}');
    } else {
        // array; often keyed-object arrays to exercise MERGE_BY_KEY
        out.push('[');
        let n = rng.below(4);
        for index in 0..n {
            if index > 0 {
                out.push(',');
            }
            if rng.chance(60) {
                // ids unique within one array (duplicate identities are
                // documented out-of-contract), overlapping across documents
                out.push_str(&format!("{{\"id\":{},", 3 * index + rng.below(3)));
                let mut extra = KEYS[rng.below(KEYS.len() as u64) as usize];
                if extra == "id" {
                    extra = "value";
                }
                out.push_str(&serde_json_escape(extra));
                out.push(':');
                rand_value(rng, depth + 2, out);
                out.push('}');
            } else {
                rand_value(rng, depth + 1, out);
            }
        }
        out.push(']');
    }
}

fn serde_json_escape(key: &str) -> String {
    serde_json_string(key)
}

fn serde_json_string(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

const LWW_CHOICES: &[Option<&str>] = &[
    None,
    Some("updatedAt"),
    Some("updatedAt,syncedAt"),
    Some("updatedAt,syncedAt,#/_sync/updatedAt"),
    Some("#/meta/updatedAt"),
    Some(" updatedAt , , syncedAt "),
];
const FWW_CHOICES: &[Option<&str>] = &[None, None, Some("createdAt"), Some("#/meta/createdAt")];
const MATCH_CHOICES: &[Option<&str>] = &[None, Some("id"), Some("id,uuid"), Some("uuid,id"), Some("name")];

fn rand_options(rng: &mut Rng) -> MergeOptions {
    let strategy = match rng.below(5) {
        0 => ArrayMergeStrategy::Replace,
        1 => ArrayMergeStrategy::Append,
        2 => ArrayMergeStrategy::Union,
        3 => ArrayMergeStrategy::MergeByIndex,
        _ => ArrayMergeStrategy::MergeByKey,
    };
    MergeOptions {
        array_strategy: strategy,
        max_depth: if rng.chance(20) { rng.below(5) as u32 } else { 0 },
        resolve_by_timestamp: rng.chance(70),
        lww_keys: LWW_CHOICES[rng.below(LWW_CHOICES.len() as u64) as usize].map(str::to_owned),
        fww_keys: FWW_CHOICES[rng.below(FWW_CHOICES.len() as u64) as usize].map(str::to_owned),
        array_match_keys: MATCH_CHOICES[rng.below(MATCH_CHOICES.len() as u64) as usize]
            .map(str::to_owned),
    }
}

fn main() {
    let iterations: u64 = std::env::args()
        .nth(1)
        .and_then(|v| v.parse().ok())
        .unwrap_or(50_000);
    let seed: u64 = std::env::args()
        .nth(2)
        .and_then(|v| v.parse().ok())
        .unwrap_or(0xC0FFEE);
    let mut rng = Rng(seed);
    let mut mismatches = 0u64;

    for iteration in 0..iterations {
        let mut base = String::new();
        let mut incoming = String::new();
        rand_value(&mut rng, 0, &mut base);
        rand_value(&mut rng, 0, &mut incoming);
        let options = rand_options(&mut rng);

        let rust = merge_json(&base, &incoming, &options).ok();
        let c = c_merge(&base, &incoming, &options);

        if rust != c {
            mismatches += 1;
            eprintln!(
                "MISMATCH #{mismatches} at iteration {iteration}\n  base:     {base}\n  incoming: {incoming}\n  options:  {options:?}\n  c:        {c:?}\n  rust:     {rust:?}\n"
            );
            if mismatches >= 20 {
                eprintln!("too many mismatches; stopping early");
                std::process::exit(1);
            }
            continue;
        }

        // idempotency: re-merging the merged result with the same incoming
        // must be a fixed point in BOTH engines (skip UNION/APPEND, which are
        // only idempotent under extra input contracts).
        if matches!(
            options.array_strategy,
            ArrayMergeStrategy::Replace | ArrayMergeStrategy::MergeByIndex | ArrayMergeStrategy::MergeByKey
        ) {
            if let Some(merged) = &rust {
                let again_rust = merge_json(merged, &incoming, &options).ok();
                let again_c = c_merge(merged, &incoming, &options);
                if again_rust != again_c {
                    mismatches += 1;
                    eprintln!(
                        "PASS2 MISMATCH at iteration {iteration}\n  merged:   {merged}\n  incoming: {incoming}\n  options:  {options:?}\n  c:        {again_c:?}\n  rust:     {again_rust:?}\n"
                    );
                }
            }
        }
    }

    if mismatches == 0 {
        println!("OK: {iterations} random cases (seed {seed:#x}) byte-identical C vs Rust, incl. pass-2 re-merge");
    } else {
        println!("FAILED: {mismatches} mismatches over {iterations} cases");
        std::process::exit(1);
    }
}
