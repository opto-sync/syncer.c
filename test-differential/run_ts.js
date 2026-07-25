#!/usr/bin/env node
"use strict";
/*
 * run_ts.js — TypeScript/Node runner for the differential test.
 * Usage: node run_ts.js <input.jsonl> <output.jsonl>
 *
 * Splits each line textually on the unique `,"incoming":` marker (corpus
 * generator contract) — never JSON.parse, so int64 precision is preserved.
 * Output lines are written exactly as returned by the native binding.
 */
const fs = require("fs");
const path = require("path");
const syncer = require(path.join(__dirname, "..", "bindings", "typescript"));

const MARKER = ',"incoming":';
const PREFIX = '{"base":';

const OPTS = {
  arrayStrategy: syncer.ArrayStrategy.MERGE_BY_KEY, // 4
  resolveByTimestamp: true,
  lwwKeys: "updatedAt,syncedAt",
  fwwKeys: "createdAt",
  arrayMatchKeys: "id",
  maxDepth: 0,
};

function main() {
  const [input, output] = process.argv.slice(2);
  if (!input || !output) {
    console.error("usage: node run_ts.js <input.jsonl> <output.jsonl>");
    process.exit(2);
  }
  const lines = fs.readFileSync(input, "utf8").split("\n");
  const out = [];
  let failures = 0;
  lines.forEach((line, i) => {
    if (line === "") return;
    const idx = line.indexOf(MARKER);
    if (idx < 0 || !line.startsWith(PREFIX) || !line.endsWith("}")) {
      console.error(`line ${i + 1}: malformed corpus line`);
      failures++;
      out.push("!MALFORMED");
      return;
    }
    const base = line.slice(PREFIX.length, idx);
    const inc = line.slice(idx + MARKER.length, line.length - 1);
    const merged = syncer.mergeJson(base, inc, OPTS);
    if (merged === null || merged === undefined) {
      console.error(`line ${i + 1}: merge returned null`);
      failures++;
      out.push("!NULL");
      return;
    }
    out.push(merged);
  });
  fs.writeFileSync(output, out.join("\n") + "\n", "utf8");
  if (failures) process.exit(1);
}

main();
