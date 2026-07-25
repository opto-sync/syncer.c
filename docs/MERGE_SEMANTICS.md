# Merge semantics

The authoritative description of what `syncer_merge_json_ex` does. Every
binding, plugin, client, and server in opto-sync delegates to this one engine,
so these rules hold identically in C, TypeScript, Dart, Rust, and Go — a
property enforced by [`test-differential/`](../test-differential/), which
requires byte-identical output across all five bindings for every input.

## The model

A merge takes a **base** (`json1`, the value you already have) and an
**incoming** (`json2`, the value arriving) and produces a new document.
Incoming data wins by default; the options below constrain when it does not.

Merging is a pure function of its inputs. There is no hidden state, no clock,
and no I/O — "which write is newer" is decided solely by timestamp fields
present *in the documents*.

## Objects

Merged key by key, recursively:

| Case | Result |
|---|---|
| Key only in base | kept |
| Key only in incoming | added |
| Both are objects | merged recursively |
| Both are arrays | per the array strategy |
| Types differ, or either is a scalar | incoming replaces base |

`max_depth` (0 = unlimited) caps recursion; at the limit a subtree is replaced
wholesale rather than merged.

## Arrays

Arrays are ambiguous in a way objects are not — an array can be a set, a list,
or a table of records — so the behavior is selectable.

| Strategy | Behavior | Idempotent |
|---|---|---|
| `REPLACE` (0, default) | incoming array replaces base | yes |
| `APPEND` (1) | incoming elements concatenated after base | **no**, by design |
| `UNION` (2) | incoming elements appended only if not already present | yes |
| `MERGE_BY_INDEX` (3) | `base[i]` merged with `incoming[i]`; longer side preserved | yes |
| `MERGE_BY_KEY` (4) | elements matched by identity key, matched pairs deep-merged | yes |

`UNION` compares elements **structurally**: object keys are an unordered set,
arrays stay order-sensitive, and integers compare exactly while any pair
involving a real compares as a double. This matters because Postgres `jsonb`
renormalizes key order on every write — a text comparison would fail to
recognize a round-tripped element as a duplicate.

Idempotency for the four strategies that claim it is verified over randomized
document pairs in [`core/test/prop_test.c`](../core/test/prop_test.c).

### MERGE_BY_KEY — reconciling records inside a jsonb column

This is the strategy for arrays of records, the common shape in a jsonb column:

```jsonc
{ "items": [ { "id": "a", "updatedAt": 2000, "qty": 1 } ] }
```

- **Identity** is the first key from `array_match_keys` (default `"id"`) that
  the incoming element actually carries. Using only the first *present* key
  keeps matching deterministic: a weaker later key can never override a missing
  match on a stronger earlier one. Numeric `42` and string `"42"` are the same
  identity, so a writer that changes the column type does not duplicate rows.
- **Matched pairs** deep-merge, subject to timestamp resolution *per element*.
- **Unmatched incoming** elements are appended, in arrival order.
- **Base-only** elements are kept.
- Elements that are not objects, or carry none of the identity keys, fall back
  to `UNION` semantics so repeated syncs stay idempotent.

Contract: an identity value should appear at most once per array. Duplicates
bind to the first match and make results unstable under repeated application.

## Timestamp resolution (LWW / FWW)

With `resolve_by_timestamp` enabled:

- `lww_keys` (e.g. `"updatedAt,syncedAt"`) — **Last-Write-Wins**: if the base's
  timestamp is newer than the incoming one, the incoming node is rejected.
- `fww_keys` (e.g. `"createdAt"`) — **First-Write-Wins**: if the incoming
  timestamp is newer, the incoming node is rejected.

Both accept comma-separated lists; surrounding spaces are tolerated; a key
participates only when **both** sides carry it.

The two lists are an **OR of vetoes**, not a precedence order, and neither is
"per field": `should_reject_by_crdt_rules` consults `fww_keys` first, then
`lww_keys`, and *any* key in *either* list that says "reject" rejects the whole
node. Adding a key to either list can therefore only ever make more incoming
data lose — listing a key you do not need is not free.

> ### ⚠️ FWW is a node-level VETO, not field protection
>
> This is the trap. "First-write-wins on `createdAt`" reads like "`createdAt`
> itself cannot be overwritten". It is not: an incoming node whose FWW key is
> newer than the base's is discarded **wholesale**, no matter how new its LWW
> key is.
>
> ```
> base     {"doc":{"createdAt":100,"updatedAt":100,"v":"base"}}
> incoming {"doc":{"createdAt":200,"updatedAt":999999,"v":"NEWEST WRITE"}}
> result   {"doc":{"createdAt":100,"updatedAt":100,"v":"base"}}
> ```
>
> The incoming node is the newest write in the system by `updatedAt`, by an
> enormous margin, and it is silently dropped. The FWW guard runs *before* the
> LWW guard and short-circuits it.
>
> The operational consequence is severe: **any replica that ends up holding a
> later `createdAt` for a record can never write to that record again.** Not
> "that field is protected" — the record becomes permanently, silently
> read-only from that replica's point of view, and the server still answers
> 200. Two devices creating the same id while offline is enough to produce it.
>
> For this reason `createdAt` is **NOT** in the default policy of the opto-sync
> clients (TypeScript, Dart, Rust) or of any opto-sync server. Their default is
> `MERGE_BY_KEY` on `"id"`, `resolve_by_timestamp = true`,
> `lww_keys = "updatedAt,syncedAt"`, and **no** `fww_keys`.
>
> Set `fww_keys` only when "the first writer owns this entire node, forever" is
> genuinely the semantics you want — and put the key on the narrowest node that
> should be frozen, never at a document root. If what you actually want is "the
> `createdAt` field should not change", that is not what FWW does; keep
> `createdAt` out of every timestamp list and let LWW govern the node.

### Comparison rules

| Both sides | Compared as |
|---|---|
| integers | exact 64-bit (nanosecond-safe) |
| any numeric pair with a real | double |
| digit strings | numerically, so `"10"` > `"9"` |
| other strings | lexicographically (correct for fixed-width ISO-8601) |
| integer vs string | the integer is normalized to a string |

Use **one format consistently per key**. Mixing formats across replicas (epoch
on one, ISO-8601 on the other) compares lexicographically and is not
chronologically meaningful.

Represent sub-millisecond timestamps as **digit strings**. Integers past 2^53
cannot survive an IEEE-754 double, so any JavaScript layer — a browser,
`express.json`, even a test harness — silently rounds them. Digit strings are
exact everywhere and still compare numerically. Rust and Dart preserve 64-bit
integers exactly; this is asserted per runtime by the cross-server suite.

### Resolution is per node, all-or-nothing

A timestamp gates the object node that contains it. If the base node wins, the
**entire** incoming node is rejected, not merely its conflicting fields — see
the FWW warning above for how badly that reads when the guard is inverted. This
is what makes stale-write rejection meaningful, and it has a consequence worth
understanding:

**Concurrent writes converge in any order only when they do not contend for the
same node's timestamp.** Mutations touching distinct keyed array elements, or
distinct fields under separate timestamped nodes, are order-independent.
Two mutations gated by the same node's `updatedAt` are *not*: applying the
older one first lets the newer one merge on top, while applying the newer one
first rejects the older entirely. Both shapes are exercised in the e2e
convergence suites, including a case that pins the boundary deliberately.

Design for convergence by giving independently-editable records their own
identity and their own timestamps.

## Return values and errors

- Returns a heap-allocated string; free it with `syncer_free` (bindings do
  this for you).
- Returns `NULL` when either input is not valid JSON. `NULL` is never an empty
  string, and bindings surface it as `null`/`None`/`{:error, _}`/an exception
  rather than silently yielding `""`.

  Two backwards-compatibility shims are the documented exceptions: Dart's
  `Syncer.merge` and Rust's `merge_json`/`merge_json_with_options` return `""`
  on failure. Use `Syncer.tryMerge` and `try_merge_json_with_options` to get the
  unambiguous `null`/`None`.
- A one-sided merge (`NULL` for one input) validates and normalizes the side
  that is present.

## Override callbacks

`override_cb` receives the full JSON path (e.g. `$.users[0].profile`) plus both
serialized values, and may return replacement JSON. An unparseable return falls
back to the default merge rather than dropping data. The returned pointer is
freed by the core with `free()`, so it must be `malloc`-allocated.

The callback is consulted for:

| Node | Consulted? |
|---|---|
| scalars, and objects at any depth | yes |
| arrays, under every strategy (incl. a root-level array, at path `$`) | yes |
| a **scalar** element of an array under `MERGE_BY_INDEX` | yes |
| a **matched object element** under `MERGE_BY_KEY` / `MERGE_BY_INDEX` | **no** |

The exception is worth knowing: a matched object element is pushed straight onto
the merge stack as a frame, so the callback sees the array (`$.arr`) and the keys
*inside* the element (`$.arr[0].qty`) but never the element itself (`$.arr[0]`).
Returning `NULL` declines and leaves the configured strategy untouched.

Path indices under `MERGE_BY_KEY` are **base-array** indices — the position the
identity matched at — not positions in the incoming array.

> Arrays used to skip the callback entirely under every non-`REPLACE` strategy,
> so an override registered for an array path was silently ignored under the
> default policy. Fixed in 0.2.1; the asymmetry is pinned by
> `test_override_reaches_arrays`.

Not every binding exposes callbacks: Rust, Go, and the BEAM binding
deliberately omit them (crossing back into a managed runtime mid-merge is a
footgun). TypeScript and Dart support them.

## Documented out-of-contract inputs

These are accepted by JSON but not supported, and were found by randomized
testing rather than assumed:

- **Duplicate keys in one object.** Lookups bind to the first occurrence, so
  results are not guaranteed stable under repeated application. No mainstream
  serializer or jsonb store produces them.
- **Duplicate identity values in one array** under `MERGE_BY_KEY` (see above).

## Robustness properties

- No C-stack recursion anywhere in the engine or in structural comparison;
  merging is an iterative DFS over a heap stack, tested to 1000 levels deep.
- Allocation failure aborts the merge cleanly and returns `NULL` rather than
  producing a partial document.
- Circular-reference detection is available via `detect_circular_refs` for
  callers building values programmatically.
