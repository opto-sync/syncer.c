# syncer-ent

Ent hook building blocks for JSON fields. Ent generates application-specific
mutation types, so this adapter accepts typed `load` and `save` closures from
your generated client instead of using reflection.

Call `Reconciler.Reconcile` with closures bound to the same transactional Ent
client (`tx.Client()`). The helper loads raw JSON, merges through syncer.c, saves
the result, and returns the persisted bytes. Using a non-transactional client
leaves the normal read-modify-write race.
