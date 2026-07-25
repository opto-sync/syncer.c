defmodule SyncerTest do
  use ExUnit.Case, async: true

  doctest Syncer

  # Decode helper: assertions are about the merged *document*, not about the
  # serializer's byte layout — except where the test is explicitly about text
  # (see the int64 timestamp test).
  defp merged!(base, incoming, opts \\ []) do
    assert {:ok, json} = Syncer.merge(base, incoming, opts)
    Jason.decode!(json)
  end

  defp crdt, do: Syncer.crdt_options()

  describe "version/0" do
    test "reports the statically linked core version" do
      assert Syncer.version() == "0.2.0"
      assert [_maj, _min, _patch] = String.split(Syncer.version(), ".")
    end
  end

  describe "merge/3 basics" do
    test "deep-merges nested objects, keeping base-only keys" do
      assert merged!(~s({"a":1,"b":{"c":2},"keep":true}), ~s({"b":{"d":3},"e":4})) == %{
               "a" => 1,
               "b" => %{"c" => 2, "d" => 3},
               "e" => 4,
               "keep" => true
             }
    end

    test "incoming scalars overwrite base scalars" do
      assert merged!(~s({"a":1}), ~s({"a":2})) == %{"a" => 2}
    end

    test "explicit null from incoming overwrites" do
      assert merged!(~s({"a":1}), ~s({"a":null})) == %{"a" => nil}
    end

    test "merging an empty object is a no-op" do
      assert merged!(~s({"a":{"b":[1,2]}}), ~s({})) == %{"a" => %{"b" => [1, 2]}}
    end

    test "max_depth stops recursing: below the limit the incoming subtree replaces the base" do
      base = ~s({"a":{"b":{"c":1}},"z":1})
      incoming = ~s({"a":{"b":{"d":2}},"y":2})

      # Unlimited (the default): the innermost objects merge.
      assert merged!(base, incoming) == %{
               "a" => %{"b" => %{"c" => 1, "d" => 2}},
               "z" => 1,
               "y" => 2
             }

      # Depth 1: "a" is at the limit, so its incoming value is taken wholesale
      # ("c" is lost) while the top-level keys still merge.
      assert merged!(base, incoming, max_depth: 1) == %{
               "a" => %{"b" => %{"d" => 2}},
               "z" => 1,
               "y" => 2
             }
    end

    test "detect_circular_refs is accepted and does not disturb an acyclic merge" do
      assert merged!(~s({"a":1}), ~s({"a":2,"b":3}), detect_circular_refs: true) == %{
               "a" => 2,
               "b" => 3
             }
    end
  end

  describe "array strategies" do
    @base ~s({"xs":[1,2]})
    @incoming ~s({"xs":[2,3]})

    test ":replace (default) discards the base array" do
      assert merged!(@base, @incoming) == %{"xs" => [2, 3]}
      assert merged!(@base, @incoming, array_strategy: :replace) == %{"xs" => [2, 3]}
    end

    test ":append concatenates" do
      assert merged!(@base, @incoming, array_strategy: :append) == %{"xs" => [1, 2, 2, 3]}
    end

    test ":union appends only elements not already present" do
      assert merged!(@base, @incoming, array_strategy: :union) == %{"xs" => [1, 2, 3]}
    end

    test ":merge_by_index deep-merges element-wise" do
      base = ~s({"xs":[{"a":1},{"b":2}]})
      incoming = ~s({"xs":[{"z":9}]})

      assert merged!(base, incoming, array_strategy: :merge_by_index) == %{
               "xs" => [%{"a" => 1, "z" => 9}, %{"b" => 2}]
             }
    end

    test ":merge_by_key matches objects by identity key rather than position" do
      base = ~s({"xs":[{"id":1,"a":1},{"id":2,"b":2}]})
      incoming = ~s({"xs":[{"id":2,"b":22}]})

      assert merged!(base, incoming, array_strategy: :merge_by_key) == %{
               "xs" => [%{"id" => 1, "a" => 1}, %{"id" => 2, "b" => 22}]
             }
    end

    test ":union dedups structurally identical objects whose key order differs" do
      # The core compares structurally (commit "Fix UNION dedup: compare
      # structurally, not by serialized text"), so {"a":1,"b":2} and
      # {"b":2,"a":1} are the same element and must not both survive.
      base = ~s({"xs":[{"a":1,"b":2}]})
      incoming = ~s({"xs":[{"b":2,"a":1},{"c":3}]})

      %{"xs" => xs} = merged!(base, incoming, array_strategy: :union)
      assert length(xs) == 2
      assert %{"a" => 1, "b" => 2} in xs
      assert %{"c" => 3} in xs
    end

    test ":union dedup is order-insensitive at depth too" do
      base = ~s({"xs":[{"o":{"p":1,"q":[1,{"r":2,"s":3}]}}]})
      incoming = ~s({"xs":[{"o":{"q":[1,{"s":3,"r":2}],"p":1}}]})

      %{"xs" => xs} = merged!(base, incoming, array_strategy: :union)
      assert length(xs) == 1
    end
  end

  describe ":merge_by_key reconciliation (CRDT options)" do
    test "matched pair deep-merges, stale element rejected, fresh sibling applied" do
      base =
        ~s({"items":[{"id":1,"updatedAt":100,"v":"keep","only_base":true},) <>
          ~s({"id":2,"updatedAt":200,"v":"old"}]})

      # Deliberately reordered: matching is by id, not index.
      incoming =
        ~s({"items":[{"id":2,"updatedAt":300,"v":"new"},) <>
          ~s({"id":1,"updatedAt":50,"v":"stale"},{"id":3,"updatedAt":1,"v":"added"}]})

      %{"items" => items} = merged!(base, incoming, crdt())
      by_id = Map.new(items, &{&1["id"], &1})

      assert map_size(by_id) == 3, "each id must appear exactly once"
      # id 1: incoming is stale (50 < 100) -> base survives.
      assert by_id[1]["v"] == "keep"
      assert by_id[1]["only_base"] == true
      # id 2: incoming is fresh (300 > 200) -> incoming wins, base keys survive.
      assert by_id[2]["v"] == "new"
      assert by_id[2]["updatedAt"] == 300
      # id 3: unmatched incoming element is appended.
      assert by_id[3]["v"] == "added"
    end

    test "base-only elements are kept even when incoming array is empty" do
      %{"items" => items} = merged!(~s({"items":[{"id":1,"v":1}]}), ~s({"items":[]}), crdt())
      assert items == [%{"id" => 1, "v" => 1}]
    end

    test "createdAt is First-Write-Wins: a re-created element loses" do
      base = ~s({"items":[{"id":1,"createdAt":100,"v":"first"}]})
      incoming = ~s({"items":[{"id":1,"createdAt":900,"v":"recreated"}]})

      %{"items" => [item]} = merged!(base, incoming, crdt())
      assert item["v"] == "first"
      assert item["createdAt"] == 100
    end

    test "numeric id 42 matches string id \"42\"" do
      base = ~s({"items":[{"id":42,"v":"base"}]})
      incoming = ~s({"items":[{"id":"42","w":"inc"}]})

      %{"items" => items} = merged!(base, incoming, array_strategy: :merge_by_key)
      assert length(items) == 1, "42 and \"42\" must be the same identity"
      assert hd(items)["v"] == "base"
      assert hd(items)["w"] == "inc"
    end

    test "array_match_keys \"uuid,id\": uuid takes precedence, id is the fallback" do
      base = ~s({"rows":[{"uuid":"u-1","id":9,"v":1},{"id":7,"v":2}]})
      incoming = ~s({"rows":[{"uuid":"u-1","id":999,"patched":true},{"id":7,"also":true}]})

      %{"rows" => rows} =
        merged!(base, incoming,
          array_strategy: :merge_by_key,
          array_match_keys: "uuid,id"
        )

      assert length(rows) == 2
      [u1, seven] = rows
      assert u1["uuid"] == "u-1"
      assert u1["patched"] == true
      assert seven["id"] == 7
      assert seven["also"] == true
      assert seven["v"] == 2
    end

    test "array_match_keys accepts a list of keys" do
      base = ~s({"rows":[{"uuid":"u-1","v":1}]})
      incoming = ~s({"rows":[{"uuid":"u-1","w":2}]})

      %{"rows" => rows} =
        merged!(base, incoming, array_strategy: :merge_by_key, array_match_keys: [:uuid, "id"])

      assert rows == [%{"uuid" => "u-1", "v" => 1, "w" => 2}]
    end

    test "repeated merges are idempotent, including non-object elements" do
      base = ~s({"items":[{"id":1,"updatedAt":100,"v":1},"x",1],"tags":["a","b"]})
      incoming = ~s({"items":[{"id":2,"updatedAt":50,"v":2},"y","x"],"tags":["b","c"]})

      assert {:ok, once} = Syncer.merge(base, incoming, crdt())
      assert {:ok, twice} = Syncer.merge(once, incoming, crdt())
      assert once == twice
    end
  end

  describe "timestamp resolution" do
    test "digit-string int64 timestamps compare numerically and survive byte-exact" do
      # "9" must not beat "10" (a strcmp would say otherwise), and a 19-digit
      # nanosecond timestamp must round-trip without float rounding.
      base = ~s({"updatedAt":"1720000000000000001","val":"base"})
      incoming = ~s({"updatedAt":"999999999999999999","val":"stale"})

      assert {:ok, json} = Syncer.merge(base, incoming, Syncer.crdt_options())
      assert json =~ ~s("1720000000000000001")
      assert Jason.decode!(json)["val"] == "base"

      # And the fresher side wins, again byte-exact.
      assert {:ok, fresh} =
               Syncer.merge(
                 ~s({"updatedAt":"1720000000000000001","val":"base"}),
                 ~s({"updatedAt":"1720000000000000002","val":"newer"}),
                 Syncer.crdt_options()
               )

      assert fresh =~ ~s("1720000000000000002")
      assert Jason.decode!(fresh)["val"] == "newer"
    end

    test "integer int64 timestamps are preserved exactly (no double rounding)" do
      base = ~s({"updatedAt":1720000000000000001,"val":"base"})
      incoming = ~s({"updatedAt":1720000000000000002,"val":"newer"})

      assert {:ok, json} = Syncer.merge(base, incoming, Syncer.crdt_options())
      assert json =~ "1720000000000000002"
      assert Jason.decode!(json)["val"] == "newer"
    end

    test "resolve_by_timestamp off means the incoming write always wins" do
      base = ~s({"updatedAt":100,"val":"base"})
      incoming = ~s({"updatedAt":50,"val":"stale"})

      assert merged!(base, incoming) == %{"updatedAt" => 50, "val" => "stale"}
    end
  end

  describe "error handling" do
    test "invalid JSON on either side returns {:error, :merge_failed}" do
      assert Syncer.merge("{oops", "{}") == {:error, :merge_failed}
      assert Syncer.merge("{}", "not json at all") == {:error, :merge_failed}
      assert Syncer.merge("", "{}") == {:error, :merge_failed}
    end

    test "an interior NUL byte fails instead of crashing the VM" do
      assert Syncer.merge(~s({"a":1}), "{\"b\":\"x\0y\"}") == {:error, :merge_failed}
    end

    test "merge!/3 raises Syncer.MergeError on bad input" do
      assert_raise Syncer.MergeError, fn -> Syncer.merge!("{oops", "{}") end
      assert Syncer.merge!(~s({"a":1}), ~s({"b":2})) =~ ~s("b":2)
    end

    test "non-binary input is a programming error" do
      assert_raise ArgumentError, fn -> Syncer.merge(%{a: 1}, "{}") end
    end
  end

  describe "option validation" do
    test "unknown options raise" do
      assert_raise ArgumentError, ~r/unknown Syncer option/, fn ->
        Syncer.merge("{}", "{}", arrayStrategy: :union)
      end
    end

    test "bad option values raise" do
      assert_raise ArgumentError, ~r/:array_strategy/, fn ->
        Syncer.merge("{}", "{}", array_strategy: :merge_by_vibes)
      end

      assert_raise ArgumentError, ~r/:max_depth/, fn ->
        Syncer.merge("{}", "{}", max_depth: -1)
      end

      assert_raise ArgumentError, ~r/:detect_circular_refs/, fn ->
        Syncer.merge("{}", "{}", detect_circular_refs: "yes")
      end

      assert_raise ArgumentError, fn -> Syncer.merge("{}", "{}", %{array_strategy: :union}) end
    end

    test "normalize_options/1 fills in every core default" do
      assert Syncer.normalize_options([]) == %{
               array_strategy: 0,
               array_match_keys: nil,
               max_depth: 0,
               detect_circular_refs: false,
               resolve_by_timestamp: false,
               lww_keys: nil,
               fww_keys: nil
             }

      assert Syncer.normalize_options(lww_keys: [:updatedAt, "syncedAt"]).lww_keys ==
               "updatedAt,syncedAt"

      # Empty key lists collapse to nil (= "unset" in the core, not "no keys").
      assert Syncer.normalize_options(fww_keys: []).fww_keys == nil
      assert Syncer.normalize_options(fww_keys: "").fww_keys == nil
    end

    test "crdt_options/1 matches the rest of the project and accepts overrides" do
      assert Syncer.crdt_options() == [
               array_strategy: :merge_by_key,
               array_match_keys: "id",
               resolve_by_timestamp: true,
               lww_keys: "updatedAt,syncedAt",
               fww_keys: "createdAt"
             ]

      opts = Syncer.crdt_options(array_match_keys: "uuid,id")
      assert Keyword.fetch!(opts, :array_match_keys) == "uuid,id"
      assert Keyword.fetch!(opts, :lww_keys) == "updatedAt,syncedAt"
    end
  end

  describe "concurrency" do
    test "many parallel merges on dirty schedulers all succeed" do
      base = ~s({"items":[{"id":1,"updatedAt":1,"v":"a"}]})

      results =
        1..64
        |> Task.async_stream(
          fn i ->
            incoming = ~s({"items":[{"id":#{i},"updatedAt":#{i + 1},"v":"w#{i}"}]})
            Syncer.merge(base, incoming, crdt())
          end,
          max_concurrency: 16
        )
        |> Enum.map(fn {:ok, res} -> res end)

      assert Enum.all?(results, &match?({:ok, _}, &1))
      assert length(results) == 64
    end
  end
end
