defmodule OptoSyncAshTest do
  use ExUnit.Case, async: true

  defmodule Doc do
    use Ash.Resource, data_layer: :embedded

    attributes do
      uuid_primary_key(:id)
      attribute(:metadata, :map)
    end
  end

  test "reconciles a changed Ash map attribute" do
    doc = %Doc{id: Ash.UUID.generate(), metadata: %{"profile" => %{"name" => "Ada"}}}

    changeset =
      doc
      |> Ash.Changeset.new()
      |> Ash.Changeset.change_attribute(:metadata, %{"profile" => %{"city" => "London"}})
      |> OptoSyncAsh.merge_attribute(:metadata)

    assert changeset.valid?

    assert Ash.Changeset.get_attribute(changeset, :metadata) == %{
             "profile" => %{"name" => "Ada", "city" => "London"}
           }
  end

  test "no changed attribute is a no-op" do
    doc = %Doc{id: Ash.UUID.generate(), metadata: %{"a" => 1}}
    changeset = Ash.Changeset.new(doc) |> OptoSyncAsh.merge_attribute(:metadata)
    assert changeset.valid?
    assert Ash.Changeset.get_attribute(changeset, :metadata) == %{"a" => 1}
  end

  test "CRDT options reject a stale object" do
    assert {:ok, merged} =
             OptoSyncAsh.merge_value(
               %{"updatedAt" => 200, "v" => "base"},
               %{"updatedAt" => 100, "v" => "stale"},
               OptoSyncAsh.crdt_options()
             )

    assert merged["v"] == "base"
  end
end
