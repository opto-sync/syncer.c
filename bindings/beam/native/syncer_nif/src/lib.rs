//! Rustler NIF wrapping the `syncer-rs` crate (which statically links the
//! syncer.c core v0.2.0).
//!
//! Design notes
//! ------------
//! * **Dirty CPU scheduler.** `merge/3` is flagged `DirtyCpu`. A JSON merge is
//!   pure, CPU-bound work with no upper bound on input size: a multi-megabyte
//!   jsonb document parses + merges + re-serializes for well over the ~1 ms a
//!   normal NIF may occupy a scheduler thread. Running it on a dirty CPU
//!   scheduler keeps a large merge from stalling the run queue of a normal
//!   scheduler (which would show up as latency spikes across unrelated
//!   processes). `version/0` is trivial and stays on a normal scheduler.
//! * **Options are pre-normalized in Elixir.** The Elixir side validates the
//!   keyword list and hands over a total map (every key present,
//!   `array_strategy` already an integer), so decoding here cannot fail on
//!   user input and no option-name knowledge is duplicated in Rust.
//! * **No override callbacks.** `syncer_merge_override_cb_ex` is deliberately
//!   not exposed; see the README.

use rustler::{Encoder, Env, NifMap, Term};
use syncer_rs::{ArrayMergeStrategy, MergeOptions};

mod atoms {
    rustler::atoms! {
        ok,
        error,
        merge_failed,
    }
}

/// Normalized option map produced by `Syncer.normalize_options/1`.
#[derive(NifMap)]
struct RawOptions {
    /// 0..=4, mirroring `syncer_array_strategy_t`.
    array_strategy: u8,
    array_match_keys: Option<String>,
    max_depth: u32,
    detect_circular_refs: bool,
    resolve_by_timestamp: bool,
    lww_keys: Option<String>,
    fww_keys: Option<String>,
}

impl From<RawOptions> for MergeOptions {
    fn from(raw: RawOptions) -> Self {
        let strategy = match raw.array_strategy {
            1 => ArrayMergeStrategy::Append,
            2 => ArrayMergeStrategy::Union,
            3 => ArrayMergeStrategy::MergeByIndex,
            4 => ArrayMergeStrategy::MergeByKey,
            // 0 and — defensively — anything else: the core's default.
            _ => ArrayMergeStrategy::Replace,
        };

        MergeOptions {
            array_strategy: Some(strategy),
            max_depth: Some(raw.max_depth),
            detect_circular_refs: raw.detect_circular_refs,
            resolve_by_timestamp: raw.resolve_by_timestamp,
            lww_keys: raw.lww_keys,
            fww_keys: raw.fww_keys,
            array_match_keys: raw.array_match_keys,
        }
    }
}

/// Deep-merges `incoming` on top of `base`.
///
/// Returns `{:ok, merged_json}`, or `{:error, :merge_failed}` when the core
/// could not produce a result (invalid JSON on either side, an interior NUL
/// byte, or allocation failure). Never returns an empty binary as a stand-in
/// for failure and never raises for ordinary bad input.
#[rustler::nif(schedule = "DirtyCpu")]
fn merge<'a>(env: Env<'a>, base: String, incoming: String, opts: RawOptions) -> Term<'a> {
    let opts: MergeOptions = opts.into();

    match syncer_rs::try_merge_json_with_options(&base, &incoming, &opts) {
        Some(merged) => (atoms::ok(), merged).encode(env),
        None => (atoms::error(), atoms::merge_failed()).encode(env),
    }
}

/// Version of the statically linked C core, e.g. `"0.2.0"`.
#[rustler::nif]
fn version() -> String {
    syncer_rs::version().to_string()
}

rustler::init!("Elixir.Syncer.Native");
