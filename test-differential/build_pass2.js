#!/usr/bin/env node
"use strict";
/*
 * build_pass2.js — constructs the idempotency-pass corpus for one language.
 *
 * Usage: node build_pass2.js corpus.jsonl results-<lang>.jsonl corpus2-<lang>.jsonl
 *
 * Each pass-2 line is {"base":<pass-1 merged output>,"incoming":<original
 * incoming>} — built by pure string concatenation (no JSON parsing, int64
 * text preserved). Re-merging must reproduce the pass-1 output byte-for-byte
 * in every language (idempotency).
 */
const fs = require("fs");

const MARKER = ',"incoming":';
const PREFIX = '{"base":';

function readLines(file) {
  const lines = fs.readFileSync(file, "utf8").split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

const [corpusFile, resultsFile, outFile] = process.argv.slice(2);
if (!corpusFile || !resultsFile || !outFile) {
  console.error("usage: node build_pass2.js <corpus.jsonl> <results.jsonl> <out.jsonl>");
  process.exit(2);
}
const corpus = readLines(corpusFile);
const results = readLines(resultsFile);
if (corpus.length !== results.length) {
  console.error(`line count mismatch: corpus ${corpus.length} vs results ${results.length}`);
  process.exit(1);
}
const out = [];
for (let i = 0; i < corpus.length; i++) {
  const line = corpus[i];
  const idx = line.indexOf(MARKER);
  if (idx < 0 || !line.startsWith(PREFIX) || !line.endsWith("}")) {
    console.error(`line ${i + 1}: malformed corpus line`);
    process.exit(1);
  }
  const inc = line.slice(idx + MARKER.length, line.length - 1);
  out.push(PREFIX + results[i] + MARKER + inc + "}");
}
fs.writeFileSync(outFile, out.join("\n") + "\n", "utf8");
