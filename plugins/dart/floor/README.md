# opto_sync_floor

Hooks for generated Floor DAOs. Pass DAO-backed load/save closures to
`FloorSyncer.reconcile` from inside one Floor/sqflite transaction. The helper
merges the stored JSON and incoming JSON through syncer.c, saves only a valid
result, and returns exactly what was persisted.
