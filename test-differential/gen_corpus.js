#!/usr/bin/env node
"use strict";
/*
 * gen_corpus.js — deterministic corpus generator for the cross-language
 * differential test.
 *
 * Emits corpus.jsonl: ~300 lines, each exactly
 *     {"base":<obj>,"incoming":<obj>}
 *
 * DETERMINISM: a seeded mulberry32 PRNG only. No Date.now, no unseeded
 * Math.random. Re-running always produces byte-identical output.
 *
 * PRECISION: every line is built by STRING CONCATENATION of raw JSON text.
 * JSON.stringify is used only for individual strings (keys / string values),
 * never for numbers that exceed 2^53. int64 timestamps such as
 * 1689940800123456789 are emitted as raw digit text.
 *
 * EXTRACTION CONTRACT: runners split each line on the first occurrence of
 * the marker `,"incoming":`. This is safe because no generated key or string
 * value ever contains the substring "incoming" (pools below are curated),
 * so the marker occurs exactly once per line.
 */

const fs = require("fs");
const path = require("path");

/* ------------------------------ seeded PRNG ------------------------------ */
function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(0xc0ffee42 | 0);
const ri = (n) => Math.floor(rand() * n); // int in [0, n)
const pick = (arr) => arr[ri(arr.length)];
const chance = (p) => rand() < p;

/* ------------------------------- pools ----------------------------------- */
/* NOTE: nothing here may contain the substring "incoming". */
const ASCII_KEYS = [
  "alpha", "beta", "gamma", "delta", "cfg", "meta", "attrs",
  "state", "notes", "stats", "payload", "flags", "extra",
];
const UNICODE_KEYS = ["ключ", "名前", "café", "übermaß", "标签🏷️", "ωμέγα"];
const STRING_VALS = [
  "hello", "wörld", "日本語のテキスト", "🚀🌟✨", "line\nbreak\ttab",
  'quote"backslash\\', "Ω≈ç√∫", "empty-ish", "ключевое значение",
  "ਪੰਜਾਬੀ", "", "  spaced  ",
];
const SCALARS = () =>
  pick([
    () => String(ri(100000)),                       // small int
    () => String(-ri(5000)),                        // negative int
    () => String(ri(1000)) + "." + String(ri(9) + 1) + String(ri(10)), // float text
    () => "true",
    () => "false",
    () => "null",
    () => JSON.stringify(pick(STRING_VALS)),
  ])();

/* ------------------------- timestamp generators -------------------------- */
/* Styles: 0=int epoch-ms, 1=string-digit, 2=float epoch-seconds, 3=big int64 ns */
function tsPair(style) {
  // Returns [olderText, newerText] as raw JSON text, older strictly < newer.
  switch (style) {
    case 0: {
      const a = 1689000000000 + ri(500000000);
      const b = a + 1 + ri(500000000);
      return [String(a), String(b)];
    }
    case 1: {
      const a = 1689000000000 + ri(500000000);
      const b = a + 1 + ri(500000000);
      return ['"' + String(a) + '"', '"' + String(b) + '"'];
    }
    case 2: {
      const a = 1689000000 + ri(500000);
      const fa = ri(999);
      let fb = ri(999);
      const b = a + 1 + ri(500000);
      return [String(a) + "." + String(fa), String(b) + "." + String(fb)];
    }
    case 3: {
      // int64 nanosecond timestamps, > 2^53: build purely as digit strings.
      // 1689940800123456789 fits int64 (max 9223372036854775807).
      const tail9 = () =>
        String(ri(10)) + String(ri(10)) + String(ri(10)) + String(ri(10)) +
        String(ri(10)) + String(ri(10)) + String(ri(10)) + String(ri(10)) +
        String(ri(10));
      const secA = 1689000000 + ri(400000);
      const secB = secA + 1 + ri(400000); // strictly larger second -> larger ns
      return [String(secA) + tail9(), String(secB) + tail9()];
    }
  }
}

/* --------------------------- object builders ----------------------------- */
function obj(pairs) {
  return "{" + pairs.filter(Boolean).join(",") + "}";
}
function kv(key, valText) {
  return JSON.stringify(key) + ":" + valText;
}

/* Nested object chain up to `depth` levels; base/incoming variants share
 * structure but diverge in leaf values and timestamps. */
function nestedPair(depth, style) {
  if (depth === 0) {
    const [oldTs, newTs] = tsPair(style);
    const baseNewer = chance(0.5);
    const basePairs = [
      kv("leafVal", SCALARS()),
      kv("shared", '"s' + ri(100) + '"'),
      chance(0.6) ? kv("updatedAt", baseNewer ? newTs : oldTs) : null,
      chance(0.3) ? kv("createdAt", baseNewer ? oldTs : newTs) : null,
      chance(0.25) ? kv(pick(UNICODE_KEYS), JSON.stringify(pick(STRING_VALS))) : null,
      chance(0.2) ? kv("gone", "null") : null,
    ];
    const incPairs = [
      kv("leafVal", SCALARS()),
      chance(0.5) ? kv("added", SCALARS()) : null,
      chance(0.6) ? kv("updatedAt", baseNewer ? oldTs : newTs) : null,
      chance(0.3) ? kv("createdAt", baseNewer ? newTs : oldTs) : null,
      chance(0.2) ? kv("gone", '"resurrected"') : null,
    ];
    return [obj(basePairs), obj(incPairs)];
  }
  const key = pick(chance(0.3) ? UNICODE_KEYS : ASCII_KEYS);
  const [b, i] = nestedPair(depth - 1, style);
  const basePairs = [kv(key, b), chance(0.3) ? kv("lvl" + depth, String(depth)) : null];
  const incPairs = [
    chance(0.85) ? kv(key, i) : kv(key, SCALARS()), // occasional type clash
    chance(0.3) ? kv("lvl" + depth + "b", String(depth)) : null,
  ];
  return [obj(basePairs), obj(incPairs)];
}

/* Array element: object with identity + timestamps + payload.
 * idText: raw JSON text of the id (int or string form). */
function element(idText, style, tsOldText, tsNewText, useNew) {
  const pairs = [
    kv("id", idText),
    chance(0.8) ? kv("updatedAt", useNew ? tsNewText : tsOldText) : null,
    chance(0.4) ? kv("createdAt", useNew ? tsOldText : tsNewText) : null,
    chance(0.3) ? kv("syncedAt", useNew ? tsNewText : tsOldText) : null,
    kv("val", SCALARS()),
    chance(0.3) ? kv(pick(UNICODE_KEYS), JSON.stringify(pick(STRING_VALS))) : null,
    chance(0.2) ? kv("sub", obj([kv("k", SCALARS())])) : null,
    chance(0.15) ? kv("blank", "{}") : null,
    chance(0.15) ? kv("nada", "null") : null,
  ];
  return obj(pairs);
}

/* Keyed array pair: overlapping ids between base and incoming. */
function keyedArrayPair(style) {
  const n = 1 + ri(5);
  const baseEls = [];
  const incEls = [];
  for (let id = 1; id <= n; id++) {
    const asString = chance(0.3);
    // Sometimes int on one side, string-digit on the other (identity
    // normalization: 42 matches "42").
    const idBase = asString ? '"' + id + '"' : String(id);
    const idInc = chance(0.15) ? (asString ? String(id) : '"' + id + '"') : idBase;
    const [oldTs, newTs] = tsPair(style);
    const baseWins = chance(0.5);
    const inBase = chance(0.8);
    const inInc = chance(0.8) || !inBase;
    if (inBase) baseEls.push(element(idBase, style, oldTs, newTs, baseWins));
    if (inInc) incEls.push(element(idInc, style, oldTs, newTs, !baseWins));
  }
  // occasionally toss a non-object element in (UNION semantics)
  if (chance(0.25)) baseEls.push(SCALARS());
  if (chance(0.25)) incEls.push(SCALARS());
  if (chance(0.1)) incEls.length = 0; // empty incoming array
  return ["[" + baseEls.join(",") + "]", "[" + incEls.join(",") + "]"];
}

function scalarArrayPair() {
  const poolGen = () =>
    pick([() => String(ri(50)), () => JSON.stringify(pick(STRING_VALS)), () => "null"])();
  const a = [], b = [];
  const n = ri(6);
  for (let i = 0; i < n; i++) {
    const v = poolGen();
    if (chance(0.7)) a.push(v);
    if (chance(0.7)) b.push(v === "null" ? "null" : poolGen());
  }
  return ["[" + a.join(",") + "]", "[" + b.join(",") + "]"];
}

/* ------------------------------ line builder ----------------------------- */
function makeLine(idx) {
  const style = idx % 4; // rotate timestamp styles deterministically
  const basePairs = [];
  const incPairs = [];

  // keyed array of objects (the main course)
  const [kb, ki] = keyedArrayPair(style);
  basePairs.push(kv("items", kb));
  incPairs.push(kv("items", ki));

  // nested objects, up to 5 deep
  const depth = 1 + ri(5);
  const [nb, ni] = nestedPair(depth, style);
  basePairs.push(kv("tree", nb));
  if (chance(0.9)) incPairs.push(kv("tree", ni));

  // scalar arrays
  if (chance(0.7)) {
    const [sb, si] = scalarArrayPair();
    basePairs.push(kv("tags", sb));
    incPairs.push(kv("tags", si));
  }

  // top-level timestamps (doc-level LWW/FWW)
  if (chance(0.6)) {
    const [oldTs, newTs] = tsPair(style);
    const baseNewer = chance(0.5);
    basePairs.push(kv("updatedAt", baseNewer ? newTs : oldTs));
    incPairs.push(kv("updatedAt", baseNewer ? oldTs : newTs));
    if (chance(0.5)) {
      basePairs.push(kv("createdAt", baseNewer ? oldTs : newTs));
      incPairs.push(kv("createdAt", baseNewer ? newTs : oldTs));
    }
    basePairs.push(kv("docVal", SCALARS()));
    incPairs.push(kv("docVal", SCALARS()));
  }

  // unicode key at top level
  if (chance(0.4)) {
    const uk = pick(UNICODE_KEYS);
    basePairs.push(kv(uk, JSON.stringify(pick(STRING_VALS))));
    if (chance(0.6)) incPairs.push(kv(uk, JSON.stringify(pick(STRING_VALS))));
  }

  // nulls, empties, string/int ids at top level
  if (chance(0.35)) basePairs.push(kv("nil", "null"));
  if (chance(0.35)) incPairs.push(kv("nil", chance(0.5) ? "null" : SCALARS()));
  if (chance(0.3)) basePairs.push(kv("emptyObj", "{}"));
  if (chance(0.3)) incPairs.push(kv("emptyObj", chance(0.5) ? "{}" : obj([kv("now", "1")])));
  if (chance(0.3)) basePairs.push(kv("emptyArr", "[]"));
  if (chance(0.3)) incPairs.push(kv("emptyArr", "[]"));
  if (chance(0.4)) {
    basePairs.push(kv("ref", chance(0.5) ? String(ri(1000)) : '"' + ri(1000) + '"'));
  }

  // dedicated big int64 field, raw text (beyond 2^53)
  if (style === 3 || chance(0.3)) {
    const [oldNs, newNs] = tsPair(3);
    basePairs.push(kv("nanoStamp", chance(0.5) ? oldNs : newNs));
    incPairs.push(kv("nanoStamp", chance(0.5) ? oldNs : newNs));
  }

  const base = obj(basePairs);
  const inc = obj(incPairs);
  return '{"base":' + base + ',"incoming":' + inc + "}";
}

/* --------------------------------- main ---------------------------------- */
const N = 300;
const lines = [];
for (let i = 0; i < N; i++) lines.push(makeLine(i));
// a few handcrafted edge lines (still deterministic)
lines.push('{"base":{},"incoming":{}}');
lines.push('{"base":{"items":[]},"incoming":{"items":[{"id":1,"updatedAt":1689940800123456789,"v":"ns"}]}}');
lines.push('{"base":{"items":[{"id":"7","updatedAt":"1689940800123","v":"a"}]},"incoming":{"items":[{"id":7,"updatedAt":"1689940800124","v":"b"}]}}');
lines.push('{"base":{"a":null,"b":{"c":[]}},"incoming":{"a":{"x":1},"b":{"c":[null,0,""]}}}');
lines.push('{"base":{"items":[{"id":1,"createdAt":1689940800123456789,"v":"first"}]},"incoming":{"items":[{"id":1,"createdAt":9223372036854775807,"v":"later"}]}}');
lines.push('{"base":{"items":[{"id":"nested-ts","_sync":{"updatedAt":"0000000000200"},"v":"base"}]},"incoming":{"items":[{"id":"nested-ts","_sync":{"updatedAt":"0000000000100"},"v":"stale"}]}}');

const out = lines.join("\n") + "\n";
const target = path.join(__dirname, "corpus.jsonl");
fs.writeFileSync(target, out, "utf8");

// sanity: marker uniqueness contract
for (const [i, l] of lines.entries()) {
  const first = l.indexOf(',"incoming":');
  const last = l.lastIndexOf(',"incoming":');
  if (first < 0 || first !== last || !l.startsWith('{"base":') || !l.endsWith("}")) {
    console.error("corpus contract violated at line " + (i + 1));
    process.exit(1);
  }
}
console.log("wrote " + lines.length + " lines to " + target);
