defmodule OptoSyncEcto.PostgresIntegrationTest do
  @moduledoc """
  End-to-end check against a real Postgres `jsonb` column.

  Excluded by default (`ExUnit.start(exclude: [:integration])`) so the normal
  `mix test` run stays hermetic. To run it, start a throwaway Postgres on a
  NON-default port and point `PG_URL` at it — see the README.
  """
  use ExUnit.Case, async: false

  @moduletag :integration

  import Ecto.Query

  alias Ecto.Adapters.SQL
  alias OptoSyncEcto.Test.Repo
  alias OptoSyncEcto.Test.SyncDoc

  @default_url "postgres://postgres:postgres@localhost:55433/postgres"

  setup_all do
    url = System.get_env("PG_URL", @default_url)
    {:ok, _pid} = Repo.start_link(url: url, pool_size: 2, log: false)

    SQL.query!(Repo, "DROP TABLE IF EXISTS sync_docs", [])

    SQL.query!(
      Repo,
      """
      CREATE TABLE sync_docs (
        id bigserial PRIMARY KEY,
        metadata jsonb,
        items jsonb
      )
      """,
      []
    )

    :ok
  end

  setup do
    SQL.query!(Repo, "TRUNCATE sync_docs", [])
    :ok
  end

  defp insert_doc(attrs) do
    Repo.insert!(struct(SyncDoc, attrs))
  end

  test "an update through merge_jsonb/3 reconciles the stored jsonb instead of replacing it" do
    doc =
      insert_doc(
        metadata: %{"a" => 1, "nested" => %{"x" => 1, "keep" => true}},
        items: [%{"id" => 1, "updatedAt" => 100, "v" => "base"}]
      )

    incoming = %{
      "metadata" => %{"a" => 2, "nested" => %{"x" => 9}},
      "items" => [
        %{"id" => 1, "updatedAt" => 50, "v" => "stale"},
        %{"id" => 2, "updatedAt" => 5, "v" => "added"}
      ]
    }

    {:ok, _} =
      doc
      |> SyncDoc.sync_changeset(incoming, OptoSyncEcto.crdt_options())
      |> Repo.update()

    reloaded = Repo.get!(SyncDoc, doc.id)

    assert reloaded.metadata == %{"a" => 2, "nested" => %{"x" => 9, "keep" => true}}

    by_id = Map.new(reloaded.items, &{&1["id"], &1})
    assert map_size(by_id) == 2
    assert by_id[1]["v"] == "base", "stale element must be rejected by updatedAt"
    assert by_id[2]["v"] == "added"

    # The column really is jsonb (queried server-side, not just round-tripped).
    assert %{rows: [["2"]]} =
             SQL.query!(Repo, "SELECT metadata->>'a' FROM sync_docs WHERE id = $1", [doc.id])
  end

  test "two writers touching different keys do not clobber each other" do
    doc = insert_doc(metadata: %{"shared" => 0})

    for {key, value} <- [{"a", 1}, {"b", 2}] do
      # Each writer re-reads the row, so its merge base is current.
      Repo.get!(SyncDoc, doc.id)
      |> SyncDoc.sync_changeset(%{"metadata" => %{key => value}}, OptoSyncEcto.crdt_options())
      |> Repo.update!()
    end

    assert Repo.get!(SyncDoc, doc.id).metadata == %{"shared" => 0, "a" => 1, "b" => 2}
  end

  test "a corrupt stored document surfaces as a changeset error, not an exception" do
    doc = insert_doc(metadata: %{"a" => 1})

    # Force the stored value to something the engine cannot parse by lying
    # about the changeset's data (equivalent to a text column with bad JSON).
    bad = %SyncDoc{doc | metadata: "{not json"}

    changeset = SyncDoc.sync_changeset(bad, %{"metadata" => %{"a" => 2}})

    refute changeset.valid?
    assert {_msg, meta} = changeset.errors[:metadata]
    assert meta[:validation] == :opto_sync_merge
    assert {:error, %Ecto.Changeset{}} = Repo.update(changeset)

    # Row untouched.
    assert Repo.get!(SyncDoc, doc.id).metadata == %{"a" => 1}
  end

  test "repeated application of the same sync payload is idempotent in the database" do
    doc = insert_doc(items: [%{"id" => 1, "updatedAt" => 1, "v" => "a"}])
    payload = %{"items" => [%{"id" => 2, "updatedAt" => 2, "v" => "b"}]}
    opts = OptoSyncEcto.crdt_options()

    for _ <- 1..3 do
      Repo.get!(SyncDoc, doc.id)
      |> SyncDoc.sync_changeset(payload, opts)
      |> Repo.update!()
    end

    items = Repo.one!(from(d in SyncDoc, where: d.id == ^doc.id, select: d.items))
    assert length(items) == 2
  end
end
