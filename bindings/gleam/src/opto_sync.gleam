/// Typed Gleam interface to the syncer.c BEAM NIF.
///
/// The Elixir `Syncer` module owns option validation and the Rustler NIF owns
/// native scheduling. This module adds Gleam types without reimplementing the
/// merge or converting JSON through Gleam values.
/// A validated option list produced by the BEAM binding.
pub type Options

/// Ordinary bad merge input is data, not an exception.
pub type MergeError {
  MergeFailed
}

/// The canonical opto-sync policy: keyed arrays, timestamp resolution,
/// `updatedAt,syncedAt` LWW selectors, and no FWW selector.
pub fn crdt_options() -> Options {
  crdt_options_raw()
}

/// Merge with the canonical opto-sync policy.
pub fn merge(
  base_json: String,
  incoming_json: String,
) -> Result(String, MergeError) {
  merge_raw(base_json, incoming_json, crdt_options())
}

/// Merge with a validated option value.
pub fn merge_with_options(
  base_json: String,
  incoming_json: String,
  options: Options,
) -> Result(String, MergeError) {
  merge_raw(base_json, incoming_json, options)
}

/// Version of the statically linked syncer.c core.
pub fn version() -> String {
  version_raw()
}

@external(erlang, "opto_sync_ffi", "crdt_options")
fn crdt_options_raw() -> Options

@external(erlang, "opto_sync_ffi", "merge")
fn merge_raw(
  base_json: String,
  incoming_json: String,
  options: Options,
) -> Result(String, MergeError)

@external(erlang, "opto_sync_ffi", "version")
fn version_raw() -> String
