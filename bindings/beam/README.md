# BEAM Ecosystem Bindings (Erlang, Elixir, Gleam)

> **Status: design doc — not yet implemented.** There is no code in this
> directory. What follows is the plan for the binding, kept in sync with the
> C core's current API (v0.2.0).

## Approach

The BEAM binding will be a Native Implemented Function (NIF) built with
[Rustler](https://github.com/rusterlium/rustler), targeting the existing
[`syncer-rs`](../rust) crate rather than the C core directly. Rust acts as
the safe boundary so a bug in native code panics into an Elixir exception
instead of segfaulting the Erlang VM.

## Architecture (planned)

1. **Host NIF (`syncer_nif`)** — a Rustler crate wrapping `syncer-rs`.
2. **Ecto Custom Type** — an `Ecto.Type` whose `cast/1`, `dump/1`, `load/1`
   route JSONB merges through the NIF.
3. **Scheduler safety** — `yyjson` parsing is fast enough for standard NIF
   execution; for very large payloads the merge NIF will be flagged as a
   Dirty NIF (CPU-bound) so it cannot block a BEAM scheduler.

## API surface it must expose (core v0.2.0)

The NIF must cover the full `syncer_merge_json_ex` option set:

```elixir
Syncer.version()
#=> "0.2.0"

Syncer.merge_json(base, incoming, opts \\ [])
```

Options (mirroring `syncer_merge_options_t`):

| Option                 | Values / type                                                        | Default    |
|------------------------|----------------------------------------------------------------------|------------|
| `:array_strategy`      | `:replace`, `:append`, `:union`, `:merge_by_index`, `:merge_by_key` | `:replace` |
| `:array_match_keys`    | comma-separated identity keys for `:merge_by_key`, e.g. `"uuid,id"` — the first listed key present in an incoming element is its identity | `"id"` |
| `:max_depth`           | non-negative integer, `0` = unlimited                                | `0`        |
| `:detect_circular_refs`| boolean                                                              | `false`    |
| `:resolve_by_timestamp`| boolean — enables CRDT-like per-key/per-element timestamp resolution | `false`    |
| `:lww_keys`            | comma-separated Last-Write-Wins keys, e.g. `"updatedAt,syncedAt"`    | none       |
| `:fww_keys`            | comma-separated First-Write-Wins keys, e.g. `"createdAt"`            | none       |

`:merge_by_key` semantics (new in v0.2.0): array elements that are objects
are matched by identity key; matched pairs deep-merge with per-element
timestamp resolution (`lww_keys`/`fww_keys`), unmatched incoming elements are
appended, base-only elements are kept, and non-object elements behave like
`:union` — making retried syncs idempotent.

Error handling: the core returns `NULL` on invalid JSON — the NIF must map
that to `{:error, :merge_failed}` (never an empty binary), and successful
merges to `{:ok, merged_json}`.

Override callbacks (`syncer_merge_override_cb_ex`) will not be exposed in
the first release: calling back from native code into BEAM processes
mid-merge would require blocking the NIF on a message round-trip.
