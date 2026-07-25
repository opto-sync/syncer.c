{application,opto_sync_nif,
             [{modules,['Elixir.Syncer','Elixir.Syncer.MergeError',
                        'Elixir.Syncer.Native']},
              {compile_env,[{opto_sync_nif,['Elixir.Syncer.Native'],error}]},
              {optional_applications,[]},
              {applications,[kernel,stdlib,elixir,logger,rustler,jason]},
              {description,"BEAM (Erlang/Elixir/Gleam) bindings for the syncer.c deep JSON merge engine, via a Rustler NIF over the syncer-rs crate."},
              {registered,[]},
              {vsn,"0.2.0"}]}.
