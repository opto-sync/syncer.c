defmodule OptoSyncAsh do
  @moduledoc """
  Ash changeset hook for reconciling map/JSON attributes through syncer.c.

  Ash resources are application-specific, so the adapter works at the public
  `Ash.Changeset` attribute surface. Add it as a custom change or call it while
  building an update changeset. Ash runs changes and `before_action` hooks
  inside the action transaction when the data layer supports transactions.
  """

  @default_message "could not be merged with the stored document"

  @spec merge_attribute(Ash.Changeset.t(), atom(), keyword()) :: Ash.Changeset.t()
  def merge_attribute(%Ash.Changeset{} = changeset, attribute, opts \\ [])
      when is_atom(attribute) do
    message = Keyword.get(opts, :message, @default_message)
    merge_opts = Keyword.delete(opts, :message)

    unless is_binary(message) do
      raise ArgumentError, ":message must be a binary"
    end

    _ = Syncer.normalize_options(merge_opts)

    if Ash.Changeset.changing_attribute?(changeset, attribute) do
      incoming = Ash.Changeset.get_attribute(changeset, attribute)
      base = Map.get(changeset.data, attribute)

      cond do
        is_nil(incoming) or is_nil(base) ->
          changeset

        true ->
          case merge_value(base, incoming, merge_opts) do
            {:ok, merged} ->
              Ash.Changeset.change_attribute(changeset, attribute, merged)

            {:error, :merge_failed} ->
              Ash.Changeset.add_error(changeset,
                field: attribute,
                message: message
              )
          end
      end
    else
      changeset
    end
  end

  @spec merge_value(term(), term(), keyword()) ::
          {:ok, term()} | {:error, :merge_failed}
  def merge_value(base, incoming, opts \\ []) do
    with {:ok, base_json} <- Jason.encode(base),
         {:ok, incoming_json} <- Jason.encode(incoming),
         {:ok, merged_json} <- Syncer.merge(base_json, incoming_json, opts),
         {:ok, merged} <- Jason.decode(merged_json) do
      {:ok, merged}
    else
      _ -> {:error, :merge_failed}
    end
  end

  defdelegate crdt_options(overrides \\ []), to: Syncer
  defdelegate engine_version(), to: Syncer, as: :version
end
