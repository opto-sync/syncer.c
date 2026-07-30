# opto_sync_ash

Ash changeset hook for map/JSON attributes. `merge_attribute/3` reads the
stored resource attribute and incoming change, reconciles them through the
syncer.c NIF, and replaces the Ash change. Merge failure becomes an Ash
changeset error.

Use it from a custom Ash change or action change. Keep the operation in the
data-layer transaction; a changeset built from stale resource data cannot by
itself prevent a lost read-modify-write.
