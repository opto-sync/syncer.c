defmodule OptoSyncEcto.Test.Repo do
  @moduledoc """
  Repo used only by the `:integration` tests (excluded by default). It is
  started explicitly by the test with a URL, so no config file is needed.
  """
  use Ecto.Repo, otp_app: :opto_sync_ecto, adapter: Ecto.Adapters.Postgres
end

defmodule OptoSyncEcto.Test.SyncDoc do
  @moduledoc """
  Schema backing the real `sync_docs` table in the `:integration` tests.
  `metadata` and `items` are `jsonb` columns.
  """
  use Ecto.Schema

  schema "sync_docs" do
    field(:metadata, :map)
    field(:items, {:array, :map})
  end

  @doc """
  The pattern this plugin exists for: cast the incoming (partial) document,
  then reconcile it against what is already stored instead of overwriting.
  """
  def sync_changeset(doc, attrs, opts \\ []) do
    doc
    |> Ecto.Changeset.cast(attrs, [:metadata, :items])
    |> OptoSyncEcto.merge_jsonb([:metadata, :items], opts)
  end
end
