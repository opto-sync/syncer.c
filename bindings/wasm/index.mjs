/**
 * @opto-sync/syncer-wasm — the syncer.c merge engine as WebAssembly.
 *
 * Default entry point: the self-contained build. The wasm bytes are inlined in
 * dist/syncer-core.single.mjs, so this module works with zero configuration in
 * a browser, in a web worker, in Node, and under every bundler — there is no
 * .wasm asset to resolve, copy or serve.
 *
 * If you would rather ship a separate, streaming-compiled .wasm (smaller JS,
 * cacheable binary), import "@opto-sync/syncer-wasm/split" instead.
 *
 *   import { initSyncer, mergeJson, ArrayStrategy } from '@opto-sync/syncer-wasm';
 *   await initSyncer();
 *   mergeJson('{"a":1}', '{"b":2}');
 */
import createSyncerModule from './dist/syncer-core.single.mjs';
import { createBinding } from './lib/wrap.mjs';

const binding = createBinding(createSyncerModule);

export const initSyncer = binding.initSyncer;
export const isReady = binding.isReady;
export const mergeJson = binding.mergeJson;
export const version = binding.version;
export const ArrayStrategy = binding.ArrayStrategy;
export const heapAllocatedBytes = binding.heapAllocatedBytes;
export const heapTotalBytes = binding.heapTotalBytes;

export default binding;
