{application,opto_sync_ecto,
             [{modules,['Elixir.OptoSyncEcto','Elixir.OptoSyncEcto.Test.Doc']},
              {optional_applications,[]},
              {applications,[kernel,stdlib,elixir,logger,ecto,jason,
                             opto_sync_nif,ecto_sql,postgrex]},
              {description,"Ecto changeset helpers that reconcile jsonb columns through the opto-sync deep-merge engine instead of overwriting them."},
              {registered,[]},
              {vsn,"0.2.0"}]}.
