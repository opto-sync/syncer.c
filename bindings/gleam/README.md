# Gleam binding

Typed Gleam interface to the existing BEAM/Rustler binding. JSON stays as
`String`, the merge runs in syncer.c on a dirty CPU scheduler, and invalid data
returns `Error(MergeFailed)`.

The application must include the sibling `bindings/beam` Mix application so
`Elixir.Syncer` and its NIF are on the BEAM code path. Standalone tooling can
instead set `OPTO_SYNC_BEAM_EBIN` to that application's compiled `ebin`
directory and `OPTO_SYNC_ELIXIR_EBIN` to the Elixir standard library's `ebin`
directory. OTP releases should include both applications normally.

```gleam
import opto_sync

let assert Ok(merged) =
  opto_sync.merge(
    "{\"items\":[{\"id\":\"a\",\"updatedAt\":1,\"value\":1}]}",
    "{\"items\":[{\"id\":\"a\",\"updatedAt\":2,\"value\":2}]}",
  )
```

Hermetic test:

```sh
docker build -f bindings/beam/Dockerfile.test -t opto-sync-beam-test .
docker run --rm -v "$PWD":/src -w /src opto-sync-beam-test sh -c '
  cd bindings/beam && mix deps.get && mix compile &&
  cd ../gleam && gleam deps download &&
  OPTO_SYNC_BEAM_EBIN=../beam/_build/dev/lib/opto_sync_nif/ebin \
  OPTO_SYNC_ELIXIR_EBIN=/usr/lib/elixir/lib/elixir/ebin \
  gleam test
'
```
