export enum ArrayMergeStrategy {
  REPLACE = 0,
  APPEND = 1,
  UNION = 2,
  MERGE_BY_INDEX = 3,
  MERGE_BY_KEY = 4,
}

/**
 * Plain constant map of array strategies (mirrors the C enum).
 * Numeric values 0-3 are unchanged; MERGE_BY_KEY is new in core v0.2.0.
 */
export const ArrayStrategy = {
  REPLACE: 0,
  APPEND: 1,
  UNION: 2,
  MERGE_BY_INDEX: 3,
  MERGE_BY_KEY: 4,
} as const;

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

// Ensure the native addon is required correctly depending on the environment.
// './build/Release/syncer.node' is the canonical location (node-gyp output next
// to this file) and MUST be tried first — same order as index.js.
let nativeSyncer: any;
try {
  nativeSyncer = require('./build/Release/syncer.node');
} catch (e) {
  try {
    nativeSyncer = require('../build/Release/syncer.node');
  } catch (e2) {
    nativeSyncer = null;
  }
}

/**
 * Deep merge two JSON strings using the native C engine.
 * @param baseJson The base JSON string
 * @param incomingJson The incoming JSON string to merge on top
 * @param options Merge behavior configuration
 * @returns The deeply merged JSON string, or null on parse error
 */
export function mergeJson(baseJson: string, incomingJson: string, options?: MergeOptions): string | null {
  if (!nativeSyncer) {
    throw new Error('Native syncer module not found. Did you compile it with node-gyp?');
  }
  return nativeSyncer.mergeJson(baseJson, incomingJson, options || {});
}

/**
 * The version of the underlying syncer.c core library ("major.minor.patch").
 */
export function version(): string {
  if (!nativeSyncer) {
    throw new Error('Native syncer module not found. Did you compile it with node-gyp?');
  }
  return nativeSyncer.version();
}
