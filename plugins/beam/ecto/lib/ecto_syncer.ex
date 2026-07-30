defmodule OptoSyncEcto do
  @moduledoc """
  Ecto changeset helpers that **reconcile** a JSON/JSONB column instead of
  overwriting it.

  A plain `Ecto.Changeset.cast/3` of a jsonb field replaces the whole stored
  document: whatever the client did not send is lost. `merge_jsonb/3` puts the
  opto-sync deep-merge engine (`Syncer`, a Rustler NIF over the syncer.c core)
  between the incoming document and the one already in `changeset.data`, so
  concurrent writers that touch different parts of the same document do not
  clobber each other, and a retried sync is idempotent.

      def changeset(doc, attrs) do
        doc
        |> Ecto.Changeset.cast(attrs, [:metadata])
        |> OptoSyncEcto.merge_jsonb(:metadata, OptoSyncEcto.crdt_options())
      end

  ## What it does

  For each requested field, in order:

  1. If the changeset has no change for the field, it is left untouched.
  2. If the change is `nil` (a deliberate `NULL`-out) or the stored value is
     `nil`/`""` (nothing to merge into), the change is left untouched.
  3. Otherwise the stored value and the incoming value are encoded to JSON,
     merged natively with the given options, and the result is put back with
     `Ecto.Changeset.put_change/3`.
  4. A merge failure becomes a **changeset error** on that field
     (`validation: :opto_sync_merge`) — never a raise, so a malformed payload
     is a `422`, not a `500`.

  The value put back keeps the *shape of the incoming change*: a map/list
  change comes back decoded (for `:map` / `{:array, :map}` columns), a binary
  change comes back as JSON text (for columns typed as `:string`/`:binary`
  holding raw JSON). That way the field is still dumped by the same
  `Ecto.Type` as before.

  ## Options

  Everything `Syncer.merge/3` accepts (`:array_strategy`, `:array_match_keys`,
  `:max_depth`, `:detect_circular_refs`, `:resolve_by_timestamp`, `:lww_keys`,
  `:fww_keys`) plus:

    * `:message` — error message added on merge failure. Defaults to
      `"could not be merged with the stored document"`.

  Options are validated eagerly, so a typo raises `ArgumentError` at the call
  site rather than silently reconciling with the wrong policy.

  ## Why this is a changeset function and not an `Ecto.Type`

  An `Ecto.Type`'s `cast/1` and `dump/1` only ever see the *incoming* value;
  merging needs the stored one too. That is available on the changeset (or in
  a `jsonb` SQL expression), so the merge lives here.
  """

  import Ecto.Changeset

  @default_message "could not be merged with the stored document"

  @typedoc "A JSON-ish value: a decoded term (map/list/scalar) or raw JSON text."
  @type json_value :: map() | list() | binary() | number() | boolean() | nil

  @doc """
  Merges the incoming change for `field` (or for every field in a list) on top
  of the value stored in `changeset.data`.

  See the module documentation for the exact rules and the options.

      iex> types = %{metadata: :map}
      iex> data = %{metadata: %{"a" => 1, "keep" => true}}
      iex> {data, types}
      ...> |> Ecto.Changeset.cast(%{"metadata" => %{"a" => 2}}, [:metadata])
      ...> |> OptoSyncEcto.merge_jsonb(:metadata)
      ...> |> Ecto.Changeset.get_change(:metadata)
      %{"a" => 2, "keep" => true}
  """
  @spec merge_jsonb(Ecto.Changeset.t(), atom() | [atom()], keyword()) :: Ecto.Changeset.t()
  def merge_jsonb(changeset, field_or_fields, opts \\ [])

  def merge_jsonb(%Ecto.Changeset{} = changeset, fields, opts) when is_list(fields) do
    {message, merge_opts} = split_opts(opts)
    Enum.reduce(fields, changeset, &do_merge(&2, &1, merge_opts, message))
  end

  def merge_jsonb(%Ecto.Changeset{} = changeset, field, opts) when is_atom(field) do
    {message, merge_opts} = split_opts(opts)
    do_merge(changeset, field, merge_opts, message)
  end

  @doc """
  Merges two JSON-ish values without a changeset.

  Accepts decoded terms or raw JSON text on either side; the result follows the
  shape of `incoming` (binary in, binary out). Useful for `Ecto.Multi` steps,
  background reconciliation jobs, and embedded documents.

      iex> OptoSyncEcto.merge_value(%{"a" => 1}, %{"b" => 2})
      {:ok, %{"a" => 1, "b" => 2}}

      iex> OptoSyncEcto.merge_value(%{"a" => 1}, "{oops")
      {:error, :merge_failed}
  """
  @spec merge_value(json_value(), json_value(), keyword()) ::
          {:ok, json_value()} | {:error, :merge_failed}
  def merge_value(base, incoming, opts \\ []) do
    {_message, merge_opts} = split_opts(opts)

    with {:ok, base_json} <- to_json(base),
         {:ok, incoming_json} <- to_json(incoming),
         {:ok, merged_json} <- Syncer.merge(base_json, incoming_json, merge_opts) do
      from_json(merged_json, incoming)
    end
  end

  @doc """
  The project-wide CRDT reconciliation policy — `:merge_by_key` on `"id"`,
  timestamp resolution on, `updatedAt`/`syncedAt` Last-Write-Wins, and no
  First-Write-Wins selector. FWW remains available as an explicit opt-in.

  Delegates to `Syncer.crdt_options/1`; `overrides` are applied on top.
  """
  @spec crdt_options(keyword()) :: keyword()
  defdelegate crdt_options(overrides \\ []), to: Syncer

  @doc """
  Version of the native merge engine backing this plugin, e.g. `"0.2.0"`.
  """
  @spec engine_version() :: binary()
  defdelegate engine_version(), to: Syncer, as: :version

  ## ---------------------------------------------------------------- internals

  defp do_merge(changeset, field, merge_opts, message) do
    with {:ok, incoming} when not is_nil(incoming) <- fetch_change(changeset, field),
         base when not is_nil(base) and base != "" <- stored_value(changeset, field) do
      case merge_value(base, incoming, merge_opts) do
        {:ok, merged} -> put_change(changeset, field, merged)
        {:error, :merge_failed} -> merge_error(changeset, field, message)
      end
    else
      # No change, an explicit nil change, or nothing stored yet: the cast
      # value stands on its own.
      _ -> changeset
    end
  end

  defp merge_error(changeset, field, message) do
    add_error(changeset, field, message, validation: :opto_sync_merge)
  end

  # `changeset.data` is a schema struct for schema changesets and a plain map
  # for schemaless (`{data, types}`) ones; Map.get covers both.
  defp stored_value(%Ecto.Changeset{data: data}, field), do: Map.get(data, field)

  defp split_opts(opts) when is_list(opts) do
    unless Keyword.keyword?(opts) do
      raise ArgumentError, "options must be a keyword list, got: #{inspect(opts)}"
    end

    {message, merge_opts} = Keyword.pop(opts, :message, @default_message)

    unless is_binary(message) do
      raise ArgumentError, ":message must be a binary, got: #{inspect(message)}"
    end

    # Validate the merge options eagerly: a typo must fail loudly here instead
    # of quietly reconciling with the wrong policy.
    _ = Syncer.normalize_options(merge_opts)
    {message, merge_opts}
  end

  defp split_opts(other) do
    raise ArgumentError, "options must be a keyword list, got: #{inspect(other)}"
  end

  # Raw JSON text passes through untouched; anything else is encoded.
  defp to_json(value) when is_binary(value), do: {:ok, value}

  defp to_json(value) do
    case Jason.encode(value) do
      {:ok, json} -> {:ok, json}
      {:error, _} -> {:error, :merge_failed}
    end
  end

  # The result's shape follows the incoming change, so the field is still
  # dumped by the Ecto type it was declared with.
  defp from_json(merged_json, incoming) when is_binary(incoming), do: {:ok, merged_json}

  defp from_json(merged_json, _incoming) do
    case Jason.decode(merged_json) do
      {:ok, decoded} -> {:ok, decoded}
      {:error, _} -> {:error, :merge_failed}
    end
  end
end
