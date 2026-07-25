defmodule Syncer do
  @moduledoc """
  Deep JSON merge for the BEAM, backed by the [syncer.c](../../core) engine
  (v0.2.0) through a Rustler NIF over the [`syncer-rs`](../rust) crate.

  Both sides of a merge are **JSON text** (`t:binary/0`), not decoded terms:
  the whole point is to hand a stored document and an incoming document to the
  native engine without paying for a round trip through Elixir maps. Callers
  holding terms should encode them first (`Jason.encode!/1`), or use the Ecto
  plugin, which does that for you.

      iex> Syncer.merge(~s({"a":1,"b":{"c":2}}), ~s({"b":{"d":3}}))
      {:ok, ~s({"a":1,"b":{"c":2,"d":3}})}

  ## Options

  All options are optional; the defaults match `syncer_default_options()` in
  the C core.

  | Option                  | Type                                                                    | Default    |
  |-------------------------|-------------------------------------------------------------------------|------------|
  | `:array_strategy`       | `:replace` \\| `:append` \\| `:union` \\| `:merge_by_index` \\| `:merge_by_key` | `:replace` |
  | `:array_match_keys`     | key list for `:merge_by_key` — binary `"uuid,id"` or `["uuid", "id"]`   | `"id"`     |
  | `:max_depth`            | non-negative integer, `0` = unlimited                                   | `0`        |
  | `:detect_circular_refs` | boolean                                                                 | `false`    |
  | `:resolve_by_timestamp` | boolean — enables CRDT-like timestamp conflict resolution               | `false`    |
  | `:lww_keys`             | Last-Write-Wins keys, e.g. `"updatedAt,syncedAt"` or `[:updatedAt]`     | none       |
  | `:fww_keys`             | First-Write-Wins keys, e.g. `"createdAt"`                               | none       |

  An unknown option key, or a value of the wrong shape, is a programming error
  and raises `ArgumentError`. Malformed *data* (invalid JSON) is not: it
  returns `{:error, :merge_failed}`.

  ## CRDT-style syncing

  `crdt_options/1` returns the option set the rest of opto-sync uses for
  reconciling replicated documents — match array elements by `"id"`, resolve
  conflicts by timestamp, `updatedAt`/`syncedAt` as Last-Write-Wins and
  `createdAt` as First-Write-Wins — which makes retried syncs idempotent:

      opts = Syncer.crdt_options()
      {:ok, once} = Syncer.merge(base, incoming, opts)
      {:ok, twice} = Syncer.merge(once, incoming, opts)
      # once == twice

  ## Scheduler safety

  The merge NIF runs on a **dirty CPU scheduler**, so a multi-megabyte
  document cannot monopolise a normal scheduler thread. See the README.

  ## Override callbacks

  The core's `syncer_merge_override_cb_ex` hook is deliberately **not**
  exposed. See the README for the reasoning.
  """

  alias Syncer.Native

  @array_strategies %{
    replace: 0,
    append: 1,
    union: 2,
    merge_by_index: 3,
    merge_by_key: 4
  }

  @option_keys [
    :array_strategy,
    :array_match_keys,
    :max_depth,
    :detect_circular_refs,
    :resolve_by_timestamp,
    :lww_keys,
    :fww_keys
  ]

  @max_u32 0xFFFFFFFF

  @typedoc "A JSON document as text."
  @type json :: binary()

  @type array_strategy :: :replace | :append | :union | :merge_by_index | :merge_by_key

  @typedoc "A comma-separated key list, or a list of keys."
  @type key_list :: binary() | [binary() | atom()]

  @type option ::
          {:array_strategy, array_strategy()}
          | {:array_match_keys, key_list() | nil}
          | {:max_depth, non_neg_integer()}
          | {:detect_circular_refs, boolean()}
          | {:resolve_by_timestamp, boolean()}
          | {:lww_keys, key_list() | nil}
          | {:fww_keys, key_list() | nil}

  @type options :: [option()]

  @doc """
  Deep-merges the JSON document `incoming` on top of `base`.

  Returns `{:ok, merged_json}`, or `{:error, :merge_failed}` if either input is
  not valid JSON (or contains an interior NUL byte, or the engine ran out of
  memory). The result is never an empty binary standing in for an error.

  Object keys present only in `base` survive; keys present in both recurse for
  objects and otherwise take the `incoming` value, unless `:resolve_by_timestamp`
  says the base write is the winner. Arrays follow `:array_strategy`.

      iex> Syncer.merge(~s({"tags":["a"]}), ~s({"tags":["b"]}), array_strategy: :union)
      {:ok, ~s({"tags":["a","b"]})}

      iex> Syncer.merge("{oops", "{}")
      {:error, :merge_failed}
  """
  @spec merge(json(), json(), options()) :: {:ok, json()} | {:error, :merge_failed}
  def merge(base, incoming, opts \\ [])

  def merge(base, incoming, opts) when is_binary(base) and is_binary(incoming) do
    Native.merge(base, incoming, normalize_options(opts))
  end

  def merge(base, incoming, _opts) do
    raise ArgumentError,
          "Syncer.merge/3 expects JSON binaries, got: #{inspect(base)} and #{inspect(incoming)}"
  end

  @doc """
  Like `merge/3` but returns the merged JSON directly and raises
  `Syncer.MergeError` when the merge fails.

  Use this only where invalid JSON means a bug rather than a bad request.
  """
  @spec merge!(json(), json(), options()) :: json()
  def merge!(base, incoming, opts \\ []) do
    case merge(base, incoming, opts) do
      {:ok, merged} -> merged
      {:error, :merge_failed} -> raise Syncer.MergeError
    end
  end

  @doc """
  The project-wide CRDT reconciliation options.

  Equivalent to:

      [
        array_strategy: :merge_by_key,
        array_match_keys: "id",
        resolve_by_timestamp: true,
        lww_keys: "updatedAt,syncedAt",
        fww_keys: "createdAt"
      ]

  `overrides` are merged on top, so you can keep the timestamp policy and
  change only the identity keys:

      Syncer.crdt_options(array_match_keys: "uuid,id")
  """
  @spec crdt_options(options()) :: options()
  def crdt_options(overrides \\ []) do
    Keyword.merge(
      [
        array_strategy: :merge_by_key,
        array_match_keys: "id",
        resolve_by_timestamp: true,
        lww_keys: "updatedAt,syncedAt",
        fww_keys: "createdAt"
      ],
      overrides
    )
  end

  @doc """
  Version of the statically linked C core, as `"major.minor.patch"`.

      iex> Syncer.version()
      "0.2.0"
  """
  @spec version() :: binary()
  def version, do: Native.version()

  @doc """
  Validates a keyword list of options and expands it into the total map the
  NIF expects. Public because the Ecto plugin validates configuration eagerly;
  most callers never need it.
  """
  @spec normalize_options(options()) :: map()
  def normalize_options(opts) when is_list(opts) do
    validate_keys!(opts)

    %{
      array_strategy: strategy!(Keyword.get(opts, :array_strategy, :replace)),
      array_match_keys: key_list!(Keyword.get(opts, :array_match_keys), :array_match_keys),
      max_depth: max_depth!(Keyword.get(opts, :max_depth, 0)),
      detect_circular_refs:
        boolean!(Keyword.get(opts, :detect_circular_refs, false), :detect_circular_refs),
      resolve_by_timestamp:
        boolean!(Keyword.get(opts, :resolve_by_timestamp, false), :resolve_by_timestamp),
      lww_keys: key_list!(Keyword.get(opts, :lww_keys), :lww_keys),
      fww_keys: key_list!(Keyword.get(opts, :fww_keys), :fww_keys)
    }
  end

  def normalize_options(other) do
    raise ArgumentError, "options must be a keyword list, got: #{inspect(other)}"
  end

  defp validate_keys!(opts) do
    unless Keyword.keyword?(opts) do
      raise ArgumentError, "options must be a keyword list, got: #{inspect(opts)}"
    end

    case Keyword.keys(opts) -- @option_keys do
      [] ->
        :ok

      unknown ->
        raise ArgumentError,
              "unknown Syncer option(s): #{inspect(unknown)}. Known options: #{inspect(@option_keys)}"
    end
  end

  defp strategy!(name) when is_map_key(@array_strategies, name), do: @array_strategies[name]

  defp strategy!(other) do
    raise ArgumentError,
          ":array_strategy must be one of #{inspect(Map.keys(@array_strategies))}, got: #{inspect(other)}"
  end

  defp key_list!(nil, _opt), do: nil
  defp key_list!("", _opt), do: nil
  defp key_list!(keys, _opt) when is_binary(keys), do: keys
  defp key_list!([], _opt), do: nil

  defp key_list!(keys, opt) when is_list(keys) do
    Enum.each(keys, fn
      key when is_binary(key) or is_atom(key) ->
        :ok

      other ->
        raise ArgumentError,
              "#{inspect(opt)} entries must be binaries or atoms, got: #{inspect(other)}"
    end)

    Enum.map_join(keys, ",", &to_string/1)
  end

  defp key_list!(other, opt) do
    raise ArgumentError,
          "#{inspect(opt)} must be a comma-separated binary or a list of keys, got: #{inspect(other)}"
  end

  defp max_depth!(depth) when is_integer(depth) and depth >= 0 and depth <= @max_u32, do: depth

  defp max_depth!(other) do
    raise ArgumentError,
          ":max_depth must be an integer in 0..#{@max_u32} (0 = unlimited), got: #{inspect(other)}"
  end

  defp boolean!(value, _opt) when is_boolean(value), do: value

  defp boolean!(other, opt) do
    raise ArgumentError, "#{inspect(opt)} must be a boolean, got: #{inspect(other)}"
  end
end

defmodule Syncer.MergeError do
  @moduledoc """
  Raised by `Syncer.merge!/3` when the engine cannot merge its inputs — almost
  always because one side is not valid JSON.
  """
  defexception message: "syncer: merge failed (invalid JSON input or out of memory)"
end
