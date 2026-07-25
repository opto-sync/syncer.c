// run_rust — Rust runner for the differential test.
// Usage: run_rust <input.jsonl> <output.jsonl>
//
// Splits each line textually on the unique `,"incoming":` marker (corpus
// generator contract) — no JSON parsing, int64 text preserved. Output lines
// are written exactly as returned by the binding.
use std::env;
use std::fs;
use std::io::Write;
use std::process::exit;

use syncer_rs::{try_merge_json_with_options, ArrayMergeStrategy, MergeOptions};

const MARKER: &str = ",\"incoming\":";
const PREFIX: &str = "{\"base\":";

fn main() {
    let args: Vec<String> = env::args().collect();
    if args.len() != 3 {
        eprintln!("usage: run_rust <input.jsonl> <output.jsonl>");
        exit(2);
    }
    let opts = MergeOptions {
        array_strategy: Some(ArrayMergeStrategy::MergeByKey), // 4
        max_depth: Some(0),
        detect_circular_refs: false,
        resolve_by_timestamp: true,
        lww_keys: Some("updatedAt,syncedAt".to_string()),
        fww_keys: Some("createdAt".to_string()),
        array_match_keys: Some("id".to_string()),
    };

    let data = fs::read_to_string(&args[1]).expect("read input");
    let mut out = String::new();
    let mut failures = 0u32;
    for (i, line) in data.lines().enumerate() {
        if line.is_empty() {
            continue;
        }
        let idx = match line.find(MARKER) {
            Some(idx) if line.starts_with(PREFIX) && line.ends_with('}') => idx,
            _ => {
                eprintln!("line {}: malformed corpus line", i + 1);
                failures += 1;
                out.push_str("!MALFORMED\n");
                continue;
            }
        };
        let base = &line[PREFIX.len()..idx];
        let inc = &line[idx + MARKER.len()..line.len() - 1];
        match try_merge_json_with_options(base, inc, &opts) {
            Some(merged) => {
                out.push_str(&merged);
                out.push('\n');
            }
            None => {
                eprintln!("line {}: merge returned None", i + 1);
                failures += 1;
                out.push_str("!NULL\n");
            }
        }
    }
    let mut f = fs::File::create(&args[2]).expect("create output");
    f.write_all(out.as_bytes()).expect("write output");
    if failures > 0 {
        exit(1);
    }
}
