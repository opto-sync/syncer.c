defmodule OptoSyncEctoTest do
  use ExUnit.Case, async: true

  import Ecto.Changeset

  alias OptoSyncEcto.Test.Doc

  doctest OptoSyncEcto

  # Schemaless changeset over a jsonb-ish :map field — no repo, no database.
  defp schemaless(stored, attrs) do
    cast({%{metadata: stored}, %{metadata: :map}}, attrs, [:metadata])
  end

  describe "merge_jsonb/3 on a schema changeset" do
    test "reconciles a jsonb map instead of replacing it" do
      stored = %Doc{
        id: "d1",
        metadata: %{"a" => 1, "nested" => %{"x" => 1, "keep" => true}}
      }

      cs = Doc.changeset(stored, %{"metadata" => %{"a" => 2, "nested" => %{"x" => 9}}})

      assert cs.valid?

      assert get_change(cs, :metadata) == %{
               "a" => 2,
               "nested" => %{"x" => 9, "keep" => true}
             }
    end

    test "leaves non-json fields alone" do
      stored = %Doc{id: "d1", title: "old", metadata: %{"a" => 1}}
      cs = Doc.changeset(stored, %{"title" => "new", "metadata" => %{"b" => 2}})

      assert get_change(cs, :title) == "new"
      assert get_change(cs, :metadata) == %{"a" => 1, "b" => 2}
    end

    test "no change for the field means no merge and no error" do
      stored = %Doc{id: "d1", metadata: %{"a" => 1}}
      cs = Doc.changeset(stored, %{"title" => "t"})

      assert cs.valid?
      assert get_change(cs, :metadata) == nil
      assert get_field(cs, :metadata) == %{"a" => 1}
    end

    test "an explicit nil change is a deliberate NULL-out and is preserved" do
      stored = %Doc{id: "d1", metadata: %{"a" => 1}}
      cs = Doc.changeset(stored, %{"metadata" => nil})

      assert cs.valid?
      assert get_field(cs, :metadata) == nil
    end

    test "nothing stored yet: the incoming value is used as-is" do
      cs = Doc.changeset(%Doc{id: "d1"}, %{"metadata" => %{"a" => 1}})

      assert cs.valid?
      assert get_change(cs, :metadata) == %{"a" => 1}
    end

    test "merges several fields in one pass, including a jsonb array" do
      stored = %Doc{
        id: "d1",
        metadata: %{"a" => 1},
        rows: [%{"id" => 1, "v" => "base"}]
      }

      cs =
        Doc.changeset(
          stored,
          %{"metadata" => %{"b" => 2}, "rows" => [%{"id" => 2, "v" => "new"}]},
          OptoSyncEcto.crdt_options()
        )

      assert cs.valid?
      assert get_change(cs, :metadata) == %{"a" => 1, "b" => 2}

      rows = get_change(cs, :rows)
      assert length(rows) == 2
      assert %{"id" => 1, "v" => "base"} in rows
      assert %{"id" => 2, "v" => "new"} in rows
    end

    test "a text column holding raw JSON stays raw JSON text" do
      stored = %Doc{id: "d1", raw: ~s({"a":1,"keep":true})}
      cs = Doc.changeset(stored, %{"raw" => ~s({"a":2})})

      merged = get_change(cs, :raw)
      assert is_binary(merged)
      assert Jason.decode!(merged) == %{"a" => 2, "keep" => true}
    end
  end

  describe "merge_jsonb/3 policy" do
    test "defaults to the core's plain deep merge (arrays replaced)" do
      stored = %Doc{id: "d1", rows: [%{"id" => 1}, %{"id" => 2}]}
      cs = Doc.changeset(stored, %{"rows" => [%{"id" => 3}]})

      assert get_change(cs, :rows) == [%{"id" => 3}]
    end

    test "CRDT options reconcile array elements by id and reject stale writes" do
      stored = %Doc{
        id: "d1",
        rows: [
          %{"id" => 1, "updatedAt" => 100, "v" => "keep"},
          %{"id" => 2, "updatedAt" => 200, "v" => "old"}
        ]
      }

      incoming = [
        %{"id" => 2, "updatedAt" => 300, "v" => "new"},
        %{"id" => 1, "updatedAt" => 50, "v" => "stale"},
        %{"id" => 3, "updatedAt" => 1, "v" => "added"}
      ]

      cs = Doc.changeset(stored, %{"rows" => incoming}, OptoSyncEcto.crdt_options())
      by_id = Map.new(get_change(cs, :rows), &{&1["id"], &1})

      assert map_size(by_id) == 3
      assert by_id[1]["v"] == "keep"
      assert by_id[2]["v"] == "new"
      assert by_id[3]["v"] == "added"
    end

    test "applying the same incoming document twice is idempotent" do
      stored = %Doc{id: "d1", rows: [%{"id" => 1, "updatedAt" => 5, "v" => "a"}]}
      incoming = %{"rows" => [%{"id" => 2, "updatedAt" => 7, "v" => "b"}]}
      opts = OptoSyncEcto.crdt_options()

      once = Doc.changeset(stored, incoming, opts) |> apply_changes()
      twice = Doc.changeset(once, incoming, opts) |> apply_changes()

      assert once.rows == twice.rows
      assert length(once.rows) == 2
    end

    test "options are passed through: :union dedups structurally" do
      cs =
        schemaless(%{"xs" => [%{"a" => 1, "b" => 2}]}, %{
          "metadata" => %{"xs" => [%{"b" => 2, "a" => 1}, %{"c" => 3}]}
        })
        |> OptoSyncEcto.merge_jsonb(:metadata, array_strategy: :union)

      assert %{"xs" => xs} = get_change(cs, :metadata)
      assert length(xs) == 2
    end

    test "an invalid option raises at the call site" do
      cs = schemaless(%{"a" => 1}, %{"metadata" => %{"a" => 2}})

      assert_raise ArgumentError, ~r/unknown Syncer option/, fn ->
        OptoSyncEcto.merge_jsonb(cs, :metadata, arrayStrategy: :union)
      end

      assert_raise ArgumentError, ~r/:message must be a binary/, fn ->
        OptoSyncEcto.merge_jsonb(cs, :metadata, message: :nope)
      end
    end
  end

  describe "merge failure" do
    test "unmergeable JSON text becomes a changeset error, not a crash" do
      stored = %Doc{id: "d1", raw: "{not json"}
      cs = Doc.changeset(stored, %{"raw" => ~s({"a":1})})

      refute cs.valid?
      assert {msg, meta} = cs.errors[:raw]
      assert msg == "could not be merged with the stored document"
      assert meta[:validation] == :opto_sync_merge
      # The bad change is not silently written through.
      assert get_change(cs, :raw) == ~s({"a":1})
    end

    test ":message overrides the error message" do
      stored = %Doc{id: "d1", raw: "{not json"}
      cs = Doc.changeset(stored, %{"raw" => ~s({"a":1})}, message: "stored document is corrupt")

      refute cs.valid?
      assert {"stored document is corrupt", _} = cs.errors[:raw]
    end

    test "a non-JSON-encodable value is reported as a merge failure" do
      # A tuple cannot be encoded to JSON; it must not raise out of the plugin.
      cs =
        schemaless(%{"a" => 1}, %{})
        |> put_change(:metadata, %{"a" => {:not, :encodable}})
        |> OptoSyncEcto.merge_jsonb(:metadata)

      refute cs.valid?
      assert {_msg, meta} = cs.errors[:metadata]
      assert meta[:validation] == :opto_sync_merge
    end
  end

  describe "merge_value/3" do
    test "merges decoded terms" do
      assert OptoSyncEcto.merge_value(%{"a" => 1, "b" => %{"c" => 1}}, %{"b" => %{"d" => 2}}) ==
               {:ok, %{"a" => 1, "b" => %{"c" => 1, "d" => 2}}}
    end

    test "merges raw JSON text and returns text" do
      assert {:ok, json} = OptoSyncEcto.merge_value(~s({"a":1}), ~s({"b":2}))
      assert is_binary(json)
      assert Jason.decode!(json) == %{"a" => 1, "b" => 2}
    end

    test "mixed shapes follow the incoming side" do
      assert {:ok, %{"a" => 1, "b" => 2}} = OptoSyncEcto.merge_value(~s({"a":1}), %{"b" => 2})
      assert {:ok, text} = OptoSyncEcto.merge_value(%{"a" => 1}, ~s({"b":2}))
      assert is_binary(text)
    end

    test "honours CRDT options" do
      base = [%{"id" => 1, "updatedAt" => 10, "v" => "base"}]
      incoming = [%{"id" => 1, "updatedAt" => 1, "v" => "stale"}]

      assert {:ok, [row]} = OptoSyncEcto.merge_value(base, incoming, OptoSyncEcto.crdt_options())
      assert row["v"] == "base"
    end

    test "reports failure instead of raising" do
      assert OptoSyncEcto.merge_value(%{"a" => 1}, "{oops") == {:error, :merge_failed}
      assert OptoSyncEcto.merge_value("nonsense{", %{"a" => 1}) == {:error, :merge_failed}
    end
  end

  describe "engine" do
    test "reports the native engine version" do
      assert OptoSyncEcto.engine_version() =~ ~r/^\d+\.\d+\.\d+$/
    end

    test "crdt_options/1 mirrors the binding and accepts overrides" do
      assert OptoSyncEcto.crdt_options() == Syncer.crdt_options()
      assert Keyword.fetch!(OptoSyncEcto.crdt_options(lww_keys: "ts"), :lww_keys) == "ts"
    end
  end
end
