"use strict";

// Load the native addon
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
 * Deep merge two JSON strings using the native C engine.
 * @param {string} baseJson The base JSON string
 * @param {string} incomingJson The incoming JSON string to merge on top
 * @param {object} [options] Merge behavior configuration
 * @param {boolean} [options.resolveByTimestamp] Enable CRDT timestamp resolution
 * @param {string} [options.lwwKeys] Comma-separated keys for Last-Write-Wins (default: "updatedAt,syncedAt")
 * @param {string} [options.fwwKeys] Comma-separated keys for First-Write-Wins (default: "createdAt")
 * @returns {string|null} The deeply merged JSON string, or null on parse error
 */
function mergeJson(baseJson, incomingJson, options) {
  if (!nativeSyncer) {
    throw new Error('Native syncer module not found. Did you compile it with node-gyp?');
  }
  return nativeSyncer.mergeJson(baseJson, incomingJson, options || {});
}

module.exports = { mergeJson };
module.exports.mergeJson = mergeJson;
module.exports.default = { mergeJson };
