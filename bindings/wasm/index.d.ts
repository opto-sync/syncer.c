/**
 * Type declarations for @opto-sync/syncer-wasm.
 *
 * Intentionally option-for-option identical to @opto-sync/syncer (the Node
 * N-API binding) so a browser build and a server build can share reconcile
 * code. The only addition is initSyncer(), because wasm must be instantiated.
 */

export declare const ArrayStrategy: {
  readonly REPLACE: 0;
  readonly APPEND: 1;
  readonly UNION: 2;
  readonly MERGE_BY_INDEX: 3;
  readonly MERGE_BY_KEY: 4;
};

export type ArrayStrategyValue = (typeof ArrayStrategy)[keyof typeof ArrayStrategy];
export type ArrayStrategyName = keyof typeof ArrayStrategy;

export interface MergeOptions {
  /** One of ArrayStrategy.* — default REPLACE (0). */
  arrayStrategy?: ArrayStrategyValue | number;
  /**
   * Comma-separated identity keys for MERGE_BY_KEY (e.g. "uuid,id"). The first
   * listed key present in an incoming element is its identity.
   *
   * Leaving this `undefined` uses the core's default ("id"); passing `''`
   * means "no identity keys" — the two are not the same.
   */
  arrayMatchKeys?: string;
  /** 0 = unlimited. */
  maxDepth?: number;
  detectCircularRefs?: boolean;
  /** Enable CRDT-like timestamp resolution. */
  resolveByTimestamp?: boolean;
  /** Comma-separated Last-Write-Wins keys. `undefined` => core default "updatedAt". */
  lwwKeys?: string;
  /** Comma-separated First-Write-Wins keys. */
  fwwKeys?: string;
  /**
   * Called for every conflicting value with the full JSON path (e.g.
   * "$.users[0].profile"). Return a JSON string to substitute, or
   * undefined/null to fall back to the default merge.
   *
   * A throw is surfaced to the caller of mergeJson() after the merge has
   * unwound; subsequent conflicts use the default merge. (Same semantics as
   * the Node binding — a JS exception must not tear through the wasm frames.)
   */
  overrideCb?: (jsonPath: string, v1: string, v2: string) => string | undefined | null;
}

export interface InitOptions {
  /**
   * Pre-fetched wasm bytes. Required for the `/split` entry point outside a
   * browser (Node cannot fetch file: URLs). Ignored by the default entry
   * point, whose wasm is inlined.
   */
  wasmBinary?: ArrayBuffer | Uint8Array;
  /** Override where the `/split` build looks for syncer-core.wasm. */
  locateFile?: (path: string, scriptDirectory: string) => string;
}

export interface SyncerWasm {
  initSyncer(options?: InitOptions): Promise<SyncerWasm>;
  isReady(): boolean;
  mergeJson(baseJson: string, incomingJson: string, options?: MergeOptions): string | null;
  mergeJson(
    baseJson: string,
    incomingJson: string,
    overrideCb: (jsonPath: string, v1: string, v2: string) => string | undefined | null,
  ): string | null;
  version(): string;
  heapAllocatedBytes(): number;
  heapTotalBytes(): number;
  readonly ArrayStrategy: typeof ArrayStrategy;
}

/**
 * Instantiate the wasm engine. Idempotent — concurrent and repeated calls
 * share one instance. Must resolve before mergeJson()/version() are used.
 */
export declare function initSyncer(options?: InitOptions): Promise<SyncerWasm>;

/** True once the engine is instantiated. */
export declare function isReady(): boolean;

/**
 * Deep merge two JSON strings. Returns the merged JSON, or `null` when either
 * input fails to parse.
 */
export declare function mergeJson(
  baseJson: string,
  incomingJson: string,
  options?: MergeOptions,
): string | null;
export declare function mergeJson(
  baseJson: string,
  incomingJson: string,
  overrideCb: (jsonPath: string, v1: string, v2: string) => string | undefined | null,
): string | null;

/** Version of the underlying syncer.c core, e.g. "0.2.0". */
export declare function version(): string;

/** Bytes currently allocated inside the wasm heap (leak diagnostics). */
export declare function heapAllocatedBytes(): number;

/** Total size of the wasm linear memory in bytes (never shrinks). */
export declare function heapTotalBytes(): number;

declare const binding: SyncerWasm;
export default binding;
