export enum ArrayMergeStrategy {
  REPLACE = 0,
  APPEND = 1,
  UNION = 2,
  MERGE_BY_INDEX = 3,
}

export interface MergeOptions {
  arrayStrategy?: ArrayMergeStrategy;
  maxDepth?: number;
  detectCircularRefs?: boolean;
  resolveByTimestamp?: boolean;
  lwwKeys?: string;
  fwwKeys?: string;
  overrideCb?: (jsonPath: string, v1: string, v2: string) => string | undefined | null;
}

// Ensure the native addon is required correctly depending on the environment
let nativeSyncer: any;
try {
  nativeSyncer = require('../build/Release/syncer.node');
} catch (e) {
  try {
    nativeSyncer = require('./build/Release/syncer.node');
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
