/**
 * @opto-sync/syncer-wasm/split — same engine, separate .wasm file.
 *
 * Trades zero-config loading for a much smaller JS payload and a streaming
 * wasm compile. Use this when you control asset hosting and care about bytes:
 * dist/syncer-core.wasm must be served next to dist/syncer-core.mjs (which is
 * what every bundler does by default, since the glue resolves it against
 * import.meta.url).
 *
 * Outside a browser there is nothing to fetch from, so pass the bytes in:
 *
 *   import { initSyncer, wasmUrl } from '@opto-sync/syncer-wasm/split';
 *   import { readFile } from 'node:fs/promises';
 *   await initSyncer({ wasmBinary: await readFile(wasmUrl) });
 *
 * The API surface is otherwise identical to the default entry point.
 */
import createSyncerModule from './dist/syncer-core.mjs';
import { createBinding } from './lib/wrap.mjs';

const binding = createBinding(createSyncerModule);

/** Location of the wasm binary, for hosts that cannot fetch it themselves. */
export const wasmUrl = new URL('./dist/syncer-core.wasm', import.meta.url);

export const initSyncer = binding.initSyncer;
export const isReady = binding.isReady;
export const mergeJson = binding.mergeJson;
export const version = binding.version;
export const ArrayStrategy = binding.ArrayStrategy;
export const heapAllocatedBytes = binding.heapAllocatedBytes;
export const heapTotalBytes = binding.heapTotalBytes;

export default binding;
