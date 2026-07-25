"use strict";

// Load the native addon.
// './build/Release/syncer.node' is the canonical location (node-gyp output
// next to this file) and MUST be tried first — same order as index.ts.
let nativeSyncer = null;
try {
  nativeSyncer = require('./build/Release/syncer.node');
} catch (e) {
  try {
    nativeSyncer = require('../build/Release/syncer.node');
  } catch (e2) {
    // Native module not available
  }
}

/**
 * Array strategies (mirrors the C enum syncer_array_strategy_t).
 * Numeric values 0-3 are unchanged; MERGE_BY_KEY is new in core v0.2.0.
 */
const ArrayStrategy = Object.freeze({
  REPLACE: 0,
  APPEND: 1,
  UNION: 2,
  MERGE_BY_INDEX: 3,
  MERGE_BY_KEY: 4,
});

/**
 * Deep merge two JSON strings using the native C engine.
 * @param {string} baseJson The base JSON string
 * @param {string} incomingJson The incoming JSON string to merge on top
 * @param {object|function} [options] Merge behavior configuration (or a legacy positional override callback)
 * @param {number} [options.arrayStrategy] One of ArrayStrategy.* (default REPLACE)
 * @param {string} [options.arrayMatchKeys] Comma-separated identity keys for MERGE_BY_KEY (e.g. "uuid,id"; default "id")
 * @param {number} [options.maxDepth] 0 = unlimited
 * @param {boolean} [options.detectCircularRefs]
 * @param {boolean} [options.resolveByTimestamp] Enable CRDT timestamp resolution
 * @param {string} [options.lwwKeys] Comma-separated keys for Last-Write-Wins (e.g. "updatedAt,syncedAt")
 * @param {string} [options.fwwKeys] Comma-separated keys for First-Write-Wins (e.g. "createdAt")
 * @param {function} [options.overrideCb] (jsonPath, v1Json, v2Json) => string|undefined
 * @returns {string|null} The deeply merged JSON string, or null on parse error
 */
function mergeJson(baseJson, incomingJson, options) {
  if (!nativeSyncer) {
    throw new Error('Native syncer module not found. Did you compile it with node-gyp?');
  }
  return nativeSyncer.mergeJson(baseJson, incomingJson, options || {});
}

/**
 * The version of the underlying syncer.c core library ("major.minor.patch").
 * @returns {string}
 */
function version() {
  if (!nativeSyncer) {
    throw new Error('Native syncer module not found. Did you compile it with node-gyp?');
  }
  return nativeSyncer.version();
}

module.exports = { mergeJson, version, ArrayStrategy };
module.exports.mergeJson = mergeJson;
module.exports.version = version;
module.exports.ArrayStrategy = ArrayStrategy;
module.exports.default = { mergeJson, version, ArrayStrategy };
