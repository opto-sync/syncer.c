# opto_sync_ecto

Ecto integration for opto-sync: **reconcile** a JSON/JSONB column on a
changeset instead of overwriting it.

A plain `cast/3` of a jsonb field replaces the whole stored document — anything
the client did not send is lost, and two clients that touch different parts of
the same document clobber each other. `OptoSyncEcto.merge_jsonb/3` runs the
stored document and the incoming one through the native
[opto-sync merge engine](../../../bindings/beam) (`Syncer`, a Rustler NIF over
the syncer.c core) and puts the merged result back into the changeset.

## Usage

```elixir
defmodule MyApp.Doc do
  use Ecto.Schema

  schema "docs" do
    field :metadata, :map            # jsonb
    field :items, {:array, :map}     # jsonb (array document)
  end

  def changeset(doc, attrs) do
    doc
    |> Ecto.Changeset.cast(attrs, [:metadata, :items])
    |> OptoSyncEcto.merge_jsonb([:metadata, :items], OptoSyncEcto.crdt_options())
  end
end
```

```elixir
OptoSyncEcto.merge_jsonb(changeset, field_or_fields, opts \\ [])
OptoSyncEcto.merge_value(base, incoming, opts \\ [])  #=> {:ok, value} | {:error, :merge_failed}
OptoSyncEcto.crdt_options(overrides \\ [])
OptoSyncEcto.engine_version()                         #=> "0.2.0"
```

### Rules

1. No change for the field → untouched.
2. Change is `nil` (a deliberate `NULL`-out) or nothing is stored yet
   (`nil`/`""`) → untouched; the cast value stands on its own.
3. Otherwise: stored value and incoming value are encoded to JSON, merged
   natively, and the result is `put_change/3`'d back.
4. A merge failure becomes a **changeset error** on the field
   (`validation: :opto_sync_merge`), so a malformed payload or a corrupt stored
   document is a `422`, never a `500`. `Repo.update/1` then returns
   `{:error, changeset}` and the row is untouched.

The value put back keeps the shape of the incoming change — a map/list comes
back decoded (for `:map` / `{:array, :map}` columns), a binary comes back as
JSON text (for `:string`/`:binary` columns holding raw JSON) — so the field is
still dumped by the same `Ecto.Type` as before.

### Options

Everything [`Syncer.merge/3`](../../../bindings/beam#options) accepts
(`:array_strategy`, `:array_match_keys`, `:max_depth`,
`:detect_circular_refs`, `:resolve_by_timestamp`, `:lww_keys`, `:fww_keys`)
plus `:message`, the error message used on merge failure. Options are
validated eagerly, so a typo raises `ArgumentError` at the call site instead of
silently reconciling with the wrong policy.

`OptoSyncEcto.crdt_options/1` is the project-wide policy: `:merge_by_key` on
`"id"`, timestamp resolution on, `updatedAt`/`syncedAt` Last-Write-Wins,
`createdAt` First-Write-Wins. With it, re-applying the same sync payload is
idempotent.

### Concurrency note

Merging fixes *lost updates within a document*, not lost updates across
transactions: each writer must re-read the row it merges into (as in the
example above). For strict serialization, wrap the read-merge-write in a
transaction with `SELECT ... FOR UPDATE`, or add an optimistic lock
(`Ecto.Changeset.optimistic_lock/2`).

### Why a changeset function and not an `Ecto.Type`?

An `Ecto.Type`'s `cast/1` and `dump/1` only ever see the incoming value;
merging needs the stored one as well. That is available on the changeset, so
the merge lives there.

## Tests

`mix test` is hermetic — it operates on changesets and embedded schemas, with
no database (22 tests + 3 doctests). The Postgres integration tests are tagged
`:integration` and excluded by default.

Using the image from the binding (`docker build -f Dockerfile.test -t
opto-sync-beam-test bindings/beam`), from the repository root:

```sh
# hermetic
docker run --rm -v "$PWD":/src -w /src/plugins/beam/ecto opto-sync-beam-test \
  sh -c 'mix deps.get && mix test'

# with a throwaway Postgres on a NON-default port (55433)
docker network create opto-sync-beam-net
docker run -d --name opto-sync-pg --network opto-sync-beam-net \
  -e POSTGRES_PASSWORD=postgres -p 55433:5432 postgres:16-alpine

docker run --rm --network opto-sync-beam-net \
  -e PG_URL=postgres://postgres:postgres@opto-sync-pg:5432/postgres \
  -v "$PWD":/src -w /src/plugins/beam/ecto opto-sync-beam-test \
  sh -c 'mix deps.get && mix test --include integration'

docker rm -f opto-sync-pg && docker network rm opto-sync-beam-net
```

The integration suite creates its own `sync_docs` table with real `jsonb`
columns and checks that reconciliation, stale-write rejection, idempotency and
merge-failure handling all behave through a live Repo. Without `PG_URL` it
falls back to `postgres://postgres:postgres@localhost:55433/postgres`.
