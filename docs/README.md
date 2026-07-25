# opto-sync documentation

Start here. Documentation spans three repos; this index covers all of them.

## Understand the behavior

| Doc | Read it when |
|---|---|
| [MERGE_SEMANTICS.md](./MERGE_SEMANTICS.md) | **The contract.** Object and array rules, all five array strategies, timestamp comparison, when concurrent writes converge and when they provably do not, out-of-contract inputs. |
| [ARCHITECTURE.md](./ARCHITECTURE.md) | You want the layering, the zero-deserialization data flow, and how the engine works internally. |
| [PERFORMANCE.md](./PERFORMANCE.md) | You need measured throughput and complexity per strategy before sizing documents. |

## Build something with it

| Doc | Read it when |
|---|---|
| [BINDINGS.md](./BINDINGS.md) | Picking or wiring a language binding (TypeScript, WebAssembly, Dart, Rust, Go, BEAM). |
| [PLUGINS.md](./PLUGINS.md) | Integrating with an ORM. **Contains the concurrency requirement — read it before shipping a read-modify-write path.** |
| [../../opto-sync-clients/docs/GETTING_STARTED.md](../../opto-sync-clients/docs/GETTING_STARTED.md) | Adopting a client library (ts / dart / rust). |
| [../../opto-sync-clients/docs/BROWSER.md](../../opto-sync-clients/docs/BROWSER.md) | Running in a browser (WebAssembly engine, bundlers, workers). |
| [../../opto-sync-clients/docs/OFFLINE_QUEUE.md](../../opto-sync-clients/docs/OFFLINE_QUEUE.md) | Implementing the optimistic queue and its durability guarantees. |
| [../../opto-sync-clients/docs/RECONCILIATION.md](../../opto-sync-clients/docs/RECONCILIATION.md) | Designing your schema and timestamp conventions. |
| [../../opto-sync-e2e/docs/SERVER_GUIDE.md](../../opto-sync-e2e/docs/SERVER_GUIDE.md) | Writing the server side. Covers CAS/retry, tombstones, unique-index identity, batch replay. |

## Operate and contribute

| Doc | Read it when |
|---|---|
| [TROUBLESHOOTING.md](./TROUBLESHOOTING.md) | Something is behaving oddly. Every entry is a failure that actually happened. |
| [COMPATIBILITY.md](./COMPATIBILITY.md) | **Before adding an option.** ABI rules for the options struct, the stale-artifact hazard, semver policy. |
| [TESTING.md](./TESTING.md) | Deciding which layer a new test belongs in, or running any suite. |
| [../CONTRIBUTING.md](../CONTRIBUTING.md) | Making a change. Includes the add-an-option checklist. |
| [SECURITY.md](./SECURITY.md) | Assessing the security posture, or reporting a vulnerability. |
| [../CHANGELOG.md](../CHANGELOG.md) | Upgrading. The 0.2.x entries include correctness fixes that affect stored data. |
| [../../opto-sync-e2e/docs/TEST_TOPOLOGY.md](../../opto-sync-e2e/docs/TEST_TOPOLOGY.md) | Navigating the e2e servers and suites. |

## The five things most likely to bite you

Each is covered in depth in [TROUBLESHOOTING.md](./TROUBLESHOOTING.md); they are
listed here because they are not guessable.

1. **A stale compiled core.** node-gyp artifacts and Go's build cache do not
   track the core's C sources, so TypeScript and Go can silently run an old
   merge engine. Assert the core version as a *lower bound*, never an exact pin.
2. **`jsonb` reorders object keys.** Merge output is semantically stable across a
   database round trip, never byte-stable. Compare parsed values.
3. **Integers past 2^53 are rounded by any JavaScript layer.** Use digit strings
   for sub-millisecond timestamps; the core compares them numerically.
4. **Read-modify-write needs a lock.** The merge is correct; unprotected
   persistence around it still loses concurrent writes. Use CAS with jittered
   retry or a row lock.
5. **Timestamp resolution is per node and all-or-nothing.** Give
   independently-editable records their own identity and timestamps, or
   concurrent edits will not converge.

## Repos

| Repo | Contents |
|---|---|
| [syncer.c](..) | The C merge engine, six language bindings, nine ORM plugins, the cross-language differential suite. |
| [opto-sync-clients](../../opto-sync-clients) | Client libraries external projects import: optimistic queue + reconcile for TypeScript, Dart, Rust. |
| [opto-sync-e2e](../../opto-sync-e2e) | Five servers in four runtimes and the end-to-end suites, including remote-browser runs on real Kubernetes clusters. |
