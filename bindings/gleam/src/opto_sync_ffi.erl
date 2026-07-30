-module(opto_sync_ffi).
-export([crdt_options/0, merge/3, version/0]).

ensure_syncer_loaded() ->
    maybe_add_path("OPTO_SYNC_ELIXIR_EBIN"),
    case code:ensure_loaded('Elixir.Syncer') of
        {module, 'Elixir.Syncer'} ->
            ok;
        _ ->
            case os:getenv("OPTO_SYNC_BEAM_EBIN") of
                false ->
                    error({opto_sync_nif_not_loaded,
                           "add bindings/beam as an application dependency"});
                Path ->
                    true = code:add_patha(Path),
                    ok = application:load(opto_sync_nif),
                    {module, 'Elixir.Syncer'} =
                        code:ensure_loaded('Elixir.Syncer'),
                    ok
            end
    end.

maybe_add_path(Name) ->
    case os:getenv(Name) of
        false -> ok;
        Path ->
            true = code:add_patha(Path),
            ok
    end.

crdt_options() ->
    ok = ensure_syncer_loaded(),
    'Elixir.Syncer':crdt_options().

merge(Base, Incoming, Options) ->
    ok = ensure_syncer_loaded(),
    'Elixir.Syncer':merge(Base, Incoming, Options).

version() ->
    ok = ensure_syncer_loaded(),
    'Elixir.Syncer':version().
