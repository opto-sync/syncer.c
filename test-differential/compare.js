#!/usr/bin/env node
"use strict";
/*
 * compare.js — asserts N result files are byte-identical line-by-line.
 *
 * Usage: node compare.js --corpus corpus.jsonl label1=file1 label2=file2 ...
 *
 * On mismatch prints the line number, the corpus inputs (base / incoming),
 * and every label's output for that line. Exit code 1 on any mismatch.
 */
const fs = require("fs");

const MARKER = ',"incoming":';
const PREFIX = '{"base":';

function readLines(file) {
  const raw = fs.readFileSync(file, "utf8");
  const lines = raw.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function main() {
  const args = process.argv.slice(2);
  let corpusFile = null;
  const entries = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--corpus") {
      corpusFile = args[++i];
    } else {
      const eq = args[i].indexOf("=");
      if (eq < 0) {
        console.error(`bad argument: ${args[i]} (expected label=file)`);
        process.exit(2);
      }
      entries.push({ label: args[i].slice(0, eq), file: args[i].slice(eq + 1) });
    }
  }
  if (entries.length < 2) {
    console.error("need at least two label=file arguments");
    process.exit(2);
  }
  const corpus = corpusFile ? readLines(corpusFile) : null;
  const sets = entries.map((e) => ({ ...e, lines: readLines(e.file) }));

  const counts = sets.map((s) => s.lines.length);
  if (new Set(counts).size !== 1) {
    console.error("LINE COUNT MISMATCH:");
    for (const s of sets) console.error(`  ${s.label}: ${s.lines.length} lines (${s.file})`);
    process.exit(1);
  }
  const n = counts[0];
  if (corpus && corpus.length !== n) {
    console.error(`warning: corpus has ${corpus.length} lines but results have ${n}`);
  }

  let mismatches = 0;
  for (let i = 0; i < n; i++) {
    const ref = sets[0].lines[i];
    const allEqual = sets.every((s) => s.lines[i] === ref);
    if (allEqual) continue;
    mismatches++;
    console.error(`\n=== MISMATCH at line ${i + 1} ===`);
    if (corpus && corpus[i] !== undefined) {
      const line = corpus[i];
      const idx = line.indexOf(MARKER);
      if (idx >= 0 && line.startsWith(PREFIX) && line.endsWith("}")) {
        console.error(`base:     ${line.slice(PREFIX.length, idx)}`);
        console.error(`incoming: ${line.slice(idx + MARKER.length, line.length - 1)}`);
      } else {
        console.error(`corpus:   ${line}`);
      }
    }
    for (const s of sets) console.error(`${s.label.padEnd(8)}: ${s.lines[i]}`);
    if (mismatches >= 20) {
      console.error("\n(stopping after 20 mismatches)");
      break;
    }
  }

  if (mismatches) {
    console.error(`\nFAIL: ${mismatches}${mismatches >= 20 ? "+" : ""} mismatching line(s) out of ${n}`);
    process.exit(1);
  }
  console.log(`OK: ${n} lines byte-identical across ${sets.map((s) => s.label).join(", ")}`);
}

main();
