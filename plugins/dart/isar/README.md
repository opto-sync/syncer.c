# opto_sync_isar

Isar embedded/object reconciliation. Use `mergeMaps`, update the generated Isar
object, and put it inside one `isar.writeTxn`; or pass collection-specific
load/save closures to `reconcile` from inside that transaction.
