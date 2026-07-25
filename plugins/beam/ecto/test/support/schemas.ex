defmodule OptoSyncEcto.Test.Doc do
  @moduledoc """
  Schema used by the hermetic changeset tests.

  It is an `embedded_schema` on purpose: everything the plugin does happens on
  a changeset, so the tests need no repo, no migration and no database.
  `:metadata` stands in for a `jsonb` column, `:raw` for a text column holding
  JSON, and `:rows` for a `jsonb` array.
  """
  use Ecto.Schema

  @primary_key {:id, :binary_id, autogenerate: false}
  embedded_schema do
    field :title, :string
    field :metadata, :map
    field :rows, {:array, :map}
    field :raw, :string
  end

  def changeset(doc, attrs, opts \\ []) do
    doc
    |> Ecto.Changeset.cast(attrs, [:title, :metadata, :rows, :raw])
    |> OptoSyncEcto.merge_jsonb([:metadata, :rows, :raw], opts)
  end
end
