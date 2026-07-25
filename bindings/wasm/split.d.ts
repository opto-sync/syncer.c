/**
 * Type declarations for @opto-sync/syncer-wasm/split — the separate-.wasm
 * entry point. Identical API plus the location of the wasm binary.
 */
export * from './index.js';
export { default } from './index.js';

/** Location of dist/syncer-core.wasm, for hosts that must load it themselves. */
export declare const wasmUrl: URL;
