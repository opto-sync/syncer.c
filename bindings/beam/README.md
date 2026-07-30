# BEAM Ecosystem Binding (Elixir / Erlang / Gleam)

Deep JSON merge for the BEAM, backed by the [syncer.c](../../core) engine
(v0.2.1). The binding is a [Rustler](https://github.com/rusterlium/rustler)
NIF wrapping the [`syncer-rs`](../rust) crate, which compiles the C core
statically via its `build.rs` — so there is **no shared library to install**
and no `LD_LIBRARY_PATH` to set. What you need at build time is a C compiler,
a Rust toolchain and Elixir/OTP.

Rust is the safety boundary: a panic in native code becomes an Elixir
exception in the calling process instead of taking down the whole VM.

| | |
|---|---|
| Mix app | `:opto_sync_nif` |
| Public module | `Syncer` |
| NIF crate | [`native/syncer_nif`](native/syncer_nif) |
| Core version | `0.2.1` (`Syncer.version/0`) |
| Status | **implemented** — 35 tests + 4 doctests green |

## Installation

The binding is not published to Hex yet; depend on it by path:

```elixir
# mix.exs
defp deps do
  [
    {:opto_sync_nif, path: "../opto-sync/syncer.c/bindings/beam"}
  ]
end
```

`mix compile` builds the NIF (cargo in release mode) and copies
`syncer_nif.so` into `priv/native/`. Requirements: Rust ≥ 1.70 with cargo, a C
compiler (`cc`), Elixir ≥ 1.14 / OTP ≥ 25.

Erlang and Gleam callers can use the same NIF through the `'Elixir.Syncer'`
module (e.g. `'Elixir.Syncer':merge(Base, Incoming, [])`); the option keyword
list is a plain proplist, so nothing Elixir-specific is required.

## API

```elixir
Syncer.version()
#=> "0.2.1"

Syncer.merge(base_json, incoming_json, opts \\ [])
#=> {:ok, merged_json} | {:error, :merge_failed}

Syncer.merge!(base_json, incoming_json, opts \\ [])
#=> merged_json, raises Syncer.MergeError on failure

Syncer.crdt_options(overrides \\ [])
#=> the project-wide CRDT policy as a keyword list

Syncer.normalize_options(opts)
#=> validated option map (used by the Ecto plugin; rarely needed directly)
```

Both sides of a merge are **JSON text** (binaries), not decoded terms — the
point of the native engine is to avoid a round trip through Elixir maps. If you
hold terms, encode them first, or use the [Ecto
plugin](../../plugins/beam/ecto), which does the encode/merge/decode dance for
you.

```elixir
iex> Syncer.merge(~s({"a":1,"b":{"c":2}}), ~s({"b":{"d":3}}))
{:ok, ~s({"a":1,"b":{"c":2,"d":3}})}

iex> Syncer.merge(~s({"tags":["a"]}), ~s({"tags":["b"]}), array_strategy: :union)
{:ok, ~s({"tags":["a","b"]})}

iex> Syncer.merge("{oops", "{}")
{:error, :merge_failed}
```

### Errors

The core returns `NULL` when it cannot produce a result — invalid JSON on
either side, an interior NUL byte in a binary, or allocation failure. The
binding maps that to `{:error, :merge_failed}`. It never returns an empty
binary as a stand-in for failure, and never raises for ordinary bad input.

Inputs are taken as raw binaries rather than Elixir `String`s, so a binary that
is not valid UTF-8 (a corrupt blob out of a database) also yields
`{:error, :merge_failed}` instead of an `ArgumentError` from the NIF decoder —
JSON is UTF-8 by definition (RFC 8259 §8.1), so such input is simply invalid
JSON.

Bad *options*, on the other hand, are a programming error and raise
`ArgumentError` (unknown key, unknown array strategy, non-boolean flag, …).

## Options

All options are optional; defaults match `syncer_default_options()` in the C
core.

| Option                  | Values / type                                                                 | Default    |
|-------------------------|-------------------------------------------------------------------------------|------------|
| `:array_strategy`       | `:replace` \| `:append` \| `:union` \| `:merge_by_index` \| `:merge_by_key`    | `:replace` |
| `:array_match_keys`     | identity keys for `:merge_by_key` — `"uuid,id"` or `["uuid", "id"]`; the first listed key present in an incoming element is its identity | `"id"` |
| `:max_depth`            | non-negative integer, `0` = unlimited                                         | `0`        |
| `:detect_circular_refs` | boolean                                                                       | `false`    |
| `:resolve_by_timestamp` | boolean — enables CRDT-like per-key / per-element timestamp resolution        | `false`    |
| `:lww_keys`             | Last-Write-Wins keys, `"updatedAt,syncedAt"` or `[:updatedAt, :syncedAt]`     | none       |
| `:fww_keys`             | First-Write-Wins keys, `"createdAt"` or `[:createdAt]`                        | none       |

Key-list options accept either a comma-separated binary (what the C core
wants) or a list of binaries/atoms, which is joined for you. `[]` and `""`
mean "unset".

### Array strategies

| Strategy | Behaviour |
|---|---|
| `:replace` | the incoming array replaces the base array |
| `:append` | incoming elements are concatenated after the base ones |
| `:union` | only incoming elements not already present are appended (compared **structurally**, so key order does not matter) |
| `:merge_by_index` | element-wise deep merge of `base[i]` with `incoming[i]` |
| `:merge_by_key` | object elements are matched by identity key, matched pairs deep-merge with per-element timestamp resolution, unmatched incoming elements are appended, base-only elements are kept; non-object elements behave like `:union` |

`:merge_by_key` is what makes retried syncs idempotent:
`merge(merge(a, b), b) == merge(a, b)`. Identity comparison is value-based, so
the number `42` and the string `"42"` are the same element.

### CRDT policy

`Syncer.crdt_options/1` is the same policy the Go/Rust/Dart/TypeScript
bindings and ORM plugins use:

```elixir
[
  array_strategy: :merge_by_key,
  array_match_keys: "id",
  resolve_by_timestamp: true,
  lww_keys: "updatedAt,syncedAt"
]
```

Overrides are applied on top: `Syncer.crdt_options(array_match_keys: "uuid,id")`.
First-Write-Wins remains available as an explicit override, but is not a
default because it vetoes an entire incoming node rather than protecting only
the selected field.

Timestamp comparison follows the core's contract: int-vs-int compares exactly
(nanosecond-safe, no float rounding), pure-digit strings compare numerically
(so `"10"` beats `"9"`), other strings compare lexicographically (correct for
fixed-width ISO-8601). Do not mix epoch numbers and ISO-8601 strings for the
same key across replicas.

## Scheduler safety: the merge NIF is dirty CPU

`merge/3` is flagged `schedule = "DirtyCpu"`.

A NIF must not occupy a normal scheduler thread for more than about a
millisecond; longer than that and the scheduler cannot run anything else,
which shows up as latency spikes and timeouts in completely unrelated
processes. Merging is pure CPU work with **no upper bound on input size** — a
multi-megabyte jsonb document has to be parsed, merged and re-serialized, and
`:merge_by_key` is quadratic in array length in the worst case. Since the work
is not divisible into small steps from the NIF's side and there is no
meaningful way to yield mid-merge, the correct tool is a dirty CPU scheduler:
the BEAM runs it on a separate thread pool sized to the machine's cores, so a
huge merge slows down only itself.

`version/0` is a constant lookup and stays on a normal scheduler.

Practical consequence: dirty CPU schedulers are a finite pool
(`+SDcpu`, defaults to the number of normal schedulers). Merges queue there
under heavy concurrency rather than degrading the rest of the VM — which is
the trade you want.

## Override callbacks: deliberately unsupported

The core exposes `syncer_merge_override_cb_ex`, a per-key hook that lets the
caller resolve a conflict itself. This binding does **not** expose it, and that
is a design decision rather than a missing feature (the Go binding makes the
same call):

* A NIF cannot call an Elixir function. Bridging the hook means sending a
  message to a BEAM process from inside native code and blocking the NIF until
  a reply arrives — on a dirty scheduler thread, holding native state, with no
  timeout story and a deadlock waiting to happen if the callback process is
  itself busy merging.
* Per-key round trips would cost orders of magnitude more than the merge.
* A crash or `exit` in the callback process would leave the native merge
  half-finished with no unwind path.

If you need custom conflict resolution, either express it with
`:lww_keys`/`:fww_keys`/`:array_match_keys`, or split the document and merge
the parts you can automatically, resolving the rest in Elixir.

## Tests

39 assertion-heavy checks (35 tests + 4 doctests) covering deep merge, all
five array strategies, `:merge_by_key` reconciliation (deep-merged matched
pair, stale element rejected by `updatedAt`, fresh sibling applied, new id
appended, base-only kept), custom `array_match_keys`, `createdAt` FWW
rejection, `42` matching `"42"`, invalid JSON, interior NUL, int64 timestamps
byte-exact, structural `:union` dedup with differing key order, idempotency,
option validation, and 64 concurrent merges over dirty schedulers.

`elixir`/`mix` are not assumed to be installed locally. Build the test image
once (Rust + C toolchain + Elixir 1.18/OTP 27):

```sh
cd syncer.c/bindings/beam
docker build -f Dockerfile.test -t opto-sync-beam-test .
```

Then, from the repository root:

```sh
docker run --rm -v "$PWD":/src -w /src/bindings/beam opto-sync-beam-test \
  sh -c 'mix deps.get && mix test'
```

The Ecto plugin's suite is run the same way:

```sh
docker run --rm -v "$PWD":/src -w /src/plugins/beam/ecto opto-sync-beam-test \
  sh -c 'mix deps.get && mix test'
```

Build output (`_build/`, `deps/`, `priv/native/`, `native/syncer_nif/target/`)
is git-ignored.

## Layout

```
bindings/beam/
├── Dockerfile.test          # rust:1.97-slim + elixir/erlang (trixie) + hex
├── lib/syncer.ex            # public API, option validation, CRDT defaults
├── lib/syncer/native.ex     # `use Rustler` NIF stubs
├── native/syncer_nif/       # Rustler crate; path dep on ../../../rust
└── test/syncer_test.exs
```

## Related

* [`../rust`](../rust) — the `syncer-rs` crate this wraps
* [`../../core/include/syncer.h`](../../core/include/syncer.h) — the C API
* [`../../plugins/beam/ecto`](../../plugins/beam/ecto) — Ecto changeset
  integration built on this binding
