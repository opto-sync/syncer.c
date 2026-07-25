# @opto-sync/syncer-wasm

The syncer.c CRDT merge engine compiled to WebAssembly.

`@opto-sync/syncer` is a Node N-API addon: it cannot be loaded in a browser, in
a service worker, or in any edge runtime. This package is the same C core —
same sources, same version string, same merge semantics — reachable from
anywhere that can run wasm. It is what makes optimistic merges against
IndexedDB actually possible on the client.

The two bindings are **drop-in interchangeable**: identical function names,
identical camelCase option names, identical return values (including `null` for
unparseable input). The only difference is that wasm has to be instantiated
first, so there is an `initSyncer()` to await.

---

## Install / usage

```js
import { initSyncer, mergeJson, version, ArrayStrategy } from '@opto-sync/syncer-wasm';

await initSyncer();            // idempotent; safe to call from many places

version();                     // "0.2.0"

mergeJson('{"a":1,"b":{"c":2}}', '{"b":{"d":3}}');
// '{"a":1,"b":{"c":2,"d":3}}'

mergeJson(localJson, serverJson, {
  arrayStrategy: ArrayStrategy.MERGE_BY_KEY,
  arrayMatchKeys: 'id',
  resolveByTimestamp: true,
  lwwKeys: 'updatedAt,syncedAt',
  fwwKeys: 'createdAt',
});
```

`initSyncer()` is idempotent and concurrency-safe: call it once at startup, or
call it at the top of every entry point — repeated and simultaneous calls share
a single wasm instance and never instantiate a second linear memory. A rejected
init is not cached, so a failure can be retried.

### API

| Export | Notes |
| --- | --- |
| `initSyncer(options?)` | `Promise<binding>`. Idempotent. `options.wasmBinary` / `options.locateFile` for custom loading. |
| `isReady()` | `true` once instantiated. |
| `mergeJson(base, incoming, options?)` | `string \| null`. `null` = either input failed to parse. |
| `version()` | Core version, `"0.2.0"`. |
| `ArrayStrategy` | `{ REPLACE: 0, APPEND: 1, UNION: 2, MERGE_BY_INDEX: 3, MERGE_BY_KEY: 4 }` |
| `heapAllocatedBytes()` / `heapTotalBytes()` | Leak diagnostics (see below). |

Merge options — exactly the Node binding's names: `arrayStrategy`,
`arrayMatchKeys`, `maxDepth`, `detectCircularRefs`, `resolveByTimestamp`,
`lwwKeys`, `fwwKeys`, `overrideCb`. A function may also be passed positionally
as the third argument, as in the Node binding's legacy form.

> **`undefined` and `''` are different options.** The core reads an absent
> `lwwKeys` as "use my default (`updatedAt`)" and an absent `arrayMatchKeys` as
> `"id"`, whereas `''` means "no keys at all". The binding preserves that
> distinction (`undefined` → `NULL`, `''` → pointer to an empty string), so
> don't normalize your options object with `x || ''`.

`overrideCb` is supported here too, including from wasm back into JS. If your
callback throws, the exception is remembered, the callback is not invoked again
for the rest of that merge (the core falls back to its default merge), and the
error is rethrown to the `mergeJson()` caller once the C frames have unwound —
the same semantics as the Node binding. Letting a JS exception tear straight
through the wasm frames would abandon every allocation the core is holding.

### TypeScript

`index.d.ts` ships with the package; `MergeOptions` is structurally identical to
the Node binding's, so a shared reconcile module can be typed against either.

---

## Two artifacts

Both are built from the same sources by the same script, and both are exercised
by the test suite.

| Import | Files loaded | Why |
| --- | --- | --- |
| `@opto-sync/syncer-wasm` | `dist/syncer-core.single.mjs` | **Default.** wasm inlined as base64 — no asset to resolve, copy, or serve. Works unchanged in browsers, workers, Node, and every bundler with zero configuration. |
| `@opto-sync/syncer-wasm/split` | `dist/syncer-core.mjs` + `dist/syncer-core.wasm` | Smaller JS and a streaming wasm compile. Use when you control asset hosting. |

### Sizes

Built with emscripten 6.0.4, `-O3 -flto`:

| File | Raw | gzip -9 |
| --- | --- | --- |
| `dist/syncer-core.wasm` | 146,003 B (143 KB) | 55,699 B (54 KB) |
| `dist/syncer-core.mjs` (split glue) | 12,417 B | 4,278 B |
| `dist/syncer-core.single.mjs` (self-contained) | 178,197 B (174 KB) | 64,241 B (63 KB) |

So: **~58 KB over the wire** for the split build, **~63 KB** for the
zero-config single-file build. The wasm is dominated by yyjson, which is what
buys the exact int64 timestamp comparison and the structural array dedup.

### Using the split build outside a browser

There is nothing to `fetch()` from, so hand it the bytes:

```js
import { initSyncer, wasmUrl } from '@opto-sync/syncer-wasm/split';
import { readFile } from 'node:fs/promises';

await initSyncer({ wasmBinary: await readFile(wasmUrl) });
```

---

## Browser and bundler notes

The glue is generated with `-sENVIRONMENT=web,worker`, so it contains **no
`require()`, no `node:` imports, no `fs`, no `__dirname`** — a test asserts
this, because a single Node builtin in the glue is what forces consumers into
polyfill configuration or breaks the build outright.

* **Vite / Rollup / webpack 5 / esbuild / Parcel** — `import '@opto-sync/syncer-wasm'`
  and you are done. The default entry has no wasm asset, so there is no
  `assetsInclude`, no `?url`, no copy step, no MIME-type configuration.
* **Web workers** — supported; put the merge on a worker if your documents are
  large enough that a synchronous merge would show up as jank.
* **Service workers** — supported (the `single` build in particular, since
  there is no second request to intercept).
* **CSP** — instantiating wasm needs `script-src 'wasm-unsafe-eval'` (or
  `'unsafe-eval'` on older browsers). This is a wasm requirement, not a choice
  this package makes.
* **`await initSyncer()` before the first merge.** `mergeJson()` throws a
  descriptive error rather than returning garbage if you forget.

Plain ES modules, no bundler:

```html
<script type="module">
  import { initSyncer, mergeJson } from '/node_modules/@opto-sync/syncer-wasm/index.mjs';
  await initSyncer();
  console.log(mergeJson('{"a":1}', '{"b":2}'));
</script>
```

---

## Memory

Every string this binding pushes into the wasm heap is freed in a `finally`
block, including on the error paths (unparseable input, throwing `overrideCb`),
and every merge result is released with `syncer_free()` after it is read back.
Function-table slots taken by `overrideCb` are recycled with `removeFunction()`
— otherwise the table would grow by one entry per merge, a leak no heap
measurement would notice.

`heapAllocatedBytes()` exposes dlmalloc's `uordblks` (bytes handed out and not
yet returned), which is how the suite proves this: it takes a baseline, runs
5,000 merges of a non-trivial document, and asserts the number is *exactly*
unchanged and that the wasm memory never had to grow.

---

## Rebuilding

`dist/` is committed on purpose — a browser app should never need emscripten in
its toolchain. To regenerate it you need Docker (emcc is not required locally):

```sh
cd syncer.c/bindings/wasm
./build.sh                 # emscripten/emsdk:6.0.4, pinned for reproducibility
npm test                   # 35 tests, ~0.4s
```

`EMSDK_IMAGE=emscripten/emsdk:latest ./build.sh` overrides the image. The
script prints raw and gzipped sizes at the end; if they move, update the table
above.

### How it is built, and why

`src/syncer_wasm.c` is the only C file this binding adds. The frozen core
(`core/src/syncer.c`, `core/src/yyjson.c`) is compiled straight from its own
tree and is not modified in any way.

The shim exists to keep the options struct out of JavaScript. The obvious
design — have JS lay out a `syncer_merge_options_t` in the heap and pass a
pointer — is a silent-corruption hazard: the struct mixes 4-byte wasm32
pointers, an enum, a `uint32_t` and two `bool`s, so its offsets and tail
padding are the compiler's business, and it has already grown once
(`array_match_keys` arrived in core v0.2.0). A JS-side layout that drifts by one
field does not crash; it feeds the core a garbage `lww_keys` pointer and merges
*wrongly*.

So JS calls a flat-argument entry point instead:

```c
char* syncer_merge_flat(const char* j1, const char* j2,
                        int strategy, unsigned max_depth,
                        int detect_circular, int resolve_ts,
                        const char* lww, const char* fww, const char* match);
```

and the shim builds the struct in C from `syncer_default_options()`, so every
field — including any field a future core release adds — is initialized by the
core's own header. Exported symbols are limited to
`syncer_merge_flat`, `syncer_merge_flat_cb`, `syncer_free`, `syncer_version`,
`syncer_wasm_alloc_bytes`, `malloc`, `free`; `syncer_merge_json_ex` is
deliberately *not* exported, so there is no way to bypass the shim.

---

## Testing

```sh
npm test        # node --test test/wasm.test.mjs
```

35 tests run under Node against the committed `dist/` artifacts — the exact
bytes a browser loads. Coverage mirrors `bindings/typescript/test.js` (all five
array strategies, `arrayMatchKeys`, per-element LWW with reordered arrays,
`fwwKeys`, `maxDepth`, invalid JSON → `null`, the override callback including
reentrancy and throwing), plus what the JS↔wasm boundary specifically puts at
risk: unicode and astral-plane round-tripping, int64 digit-string timestamp
precision, `undefined` vs `''` option handling, UNION structural dedup with
reordered keys, split-vs-single-file output equality, absence of Node builtins
in the glue, and the 5,000-iteration leak check.

Cross-engine equivalence against the native addon (byte-identical output on a
shared corpus) is asserted from the TypeScript client, which depends on both:
see `opto-sync-clients/clients/ts/test/engine-parity.test.js`.
