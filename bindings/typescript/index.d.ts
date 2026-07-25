/**
 * Type declarations for the runtime entry point (index.js).
 * Keep in sync with index.ts / index.js.
 */

export declare enum ArrayMergeStrategy {
  REPLACE = 0,
  APPEND = 1,
  UNION = 2,
  MERGE_BY_INDEX = 3,
  MERGE_BY_KEY = 4,
}

export declare const ArrayStrategy: {
  readonly REPLACE: 0;
  readonly APPEND: 1;
  readonly UNION: 2;
  readonly MERGE_BY_INDEX: 3;
  readonly MERGE_BY_KEY: 4;
};

export type ArrayStrategyName = keyof typeof ArrayStrategy;

export interface MergeOptions {
  arrayStrategy?: ArrayMergeStrategy | number;
  /**
   * Comma-separated identity keys for MERGE_BY_KEY (e.g. "uuid,id").
   * The first listed key present in an incoming element is its identity.
   * Defaults to "id" in the core.
   */
  arrayMatchKeys?: string;
  maxDepth?: number;
  detectCircularRefs?: boolean;
  resolveByTimestamp?: boolean;
  lwwKeys?: string;
  fwwKeys?: string;
  overrideCb?: (jsonPath: string, v1: string, v2: string) => string | undefined | null;
}

/**
 * Deep merge two JSON strings using the native C engine.
 * Returns the merged JSON string, or null on parse error.
 */
export declare function mergeJson(
  baseJson: string,
  incomingJson: string,
  options?: MergeOptions,
): string | null;

/**
 * The version of the underlying syncer.c core library ("major.minor.patch").
 */
export declare function version(): string;
