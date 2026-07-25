"use strict";

/*
 * test-concurrency.js — concurrency + reentrancy tests for the native addon.
 *
 * NOT wired into test.js: run manually with `node test-concurrency.js`.
 *
 * Part 1: worker_threads — 8 workers x 200 merges each through the native
 *   addon with full options (MERGE_BY_KEY + timestamp resolution +
 *   lww/fww + custom match keys). The core's ex path is stateless, and the
 *   addon's callback slot is thread_local, so every worker must produce
 *   output byte-identical to the main thread's single-threaded result.
 *
 * Part 2: reentrancy — an overrideCb that itself calls mergeJson (a nested
 *   merge, including a nested merge that ALSO uses an override callback).
 *   The addon saves/restores the thread_local callback slot around each
 *   call, so the outer merge's callback must keep firing correctly after
 *   the nested merge returns. Validates no crash + correct output.
 */

const { Worker, isMainThread, parentPort, workerData } = require("worker_threads");
const assert = require("assert");
const { mergeJson, ArrayStrategy } = require("./index.js");

const BASE = JSON.stringify({
  items: [
    { id: 1, updatedAt: 100, v: "keep", tag: "base-only" },
    { id: 2, updatedAt: 200, v: "old" },
    { uuid: "u-9", id: 9, createdAt: 10, v: "first" },
  ],
  meta: { updatedAt: 500, owner: "base" },
  tags: ["a", "b"],
});

const INCOMING = JSON.stringify({
  items: [
    { id: 2, updatedAt: 300, v: "new" },
    { id: 1, updatedAt: 50, v: "stale" },
    { uuid: "u-9", createdAt: 900, v: "recreated" },
    { id: 3, v: "appended" },
  ],
  meta: { updatedAt: 400, owner: "stale-writer" },
  tags: ["b", "c"],
});

const OPTIONS = {
  arrayStrategy: ArrayStrategy.MERGE_BY_KEY,
  resolveByTimestamp: true,
  lwwKeys: "updatedAt,syncedAt",
  fwwKeys: "createdAt",
  arrayMatchKeys: "uuid,id",
};

// ---------------------------------------------------------------------------
// Worker body
// ---------------------------------------------------------------------------
if (!isMainThread) {
  const { iterations, expected } = workerData;
  let divergences = 0;
  let firstDivergence = null;
  for (let i = 0; i < iterations; i++) {
    const got = mergeJson(BASE, INCOMING, OPTIONS);
    if (got !== expected) {
      divergences++;
      if (firstDivergence === null) firstDivergence = { iter: i, got };
    }
  }
  parentPort.postMessage({ divergences, firstDivergence });
  return;
}

// ---------------------------------------------------------------------------
// Main thread
// ---------------------------------------------------------------------------
function testWorkerThreadConcurrency() {
  const expected = mergeJson(BASE, INCOMING, OPTIONS);
  assert.ok(expected, "reference merge returned null");
  // Sanity: reference actually exercised the option paths.
  for (const want of ['"v":"keep"', '"v":"new"', '"v":"first"', '"v":"appended"', '"owner":"base"']) {
    assert.ok(expected.includes(want), `reference missing ${want}: ${expected}`);
  }
  assert.ok(!expected.includes("stale") && !expected.includes("recreated"),
    `reference kept a losing write: ${expected}`);

  const WORKERS = 8;
  const ITERATIONS = 200;

  const jobs = [];
  for (let w = 0; w < WORKERS; w++) {
    jobs.push(new Promise((resolve, reject) => {
      const worker = new Worker(__filename, {
        workerData: { iterations: ITERATIONS, expected },
      });
      worker.once("message", (msg) => resolve({ w, ...msg }));
      worker.once("error", reject);
      worker.once("exit", (code) => {
        if (code !== 0) reject(new Error(`worker ${w} exited with code ${code}`));
      });
    }));
  }

  return Promise.all(jobs).then((results) => {
    for (const r of results) {
      if (r.divergences > 0) {
        throw new Error(
          `worker ${r.w}: ${r.divergences}/${ITERATIONS} divergent results; ` +
          `first at iter ${r.firstDivergence.iter}:\n${r.firstDivergence.got}\nexpected:\n${expected}`);
      }
    }
    console.log(`PASS worker_threads: ${WORKERS} workers x ${ITERATIONS} merges, all outputs identical to single-threaded result`);
  });
}

function testReentrantOverrideCallback() {
  // Inner merge inputs used from inside the outer merge's override callback.
  const innerBase = '{"x":1,"nested":{"y":2}}';
  const innerIncoming = '{"nested":{"z":3},"w":4}';
  const innerExpected = mergeJson(innerBase, innerIncoming);
  assert.ok(innerExpected, "inner reference merge returned null");

  let outerCalls = 0;
  let innerResultsOk = true;

  // Outer override: for the key "combine", RETURN the result of a nested
  // mergeJson call; for everything else defer to the default merge but
  // still run a nested merge to hammer the save/restore path.
  const outerCb = (path, v1, v2) => {
    outerCalls++;
    const nested = mergeJson(innerBase, innerIncoming); // re-entrant, no cb
    if (nested !== innerExpected) innerResultsOk = false;

    // Nested merge that ITSELF uses an override callback: overwrites the
    // thread_local slot during the outer merge; save/restore must undo it.
    const nestedWithCb = mergeJson('{"k":1}', '{"k":2}', {
      overrideCb: () => '"cb-nested"',
    });
    if (nestedWithCb !== '{"k":"cb-nested"}') innerResultsOk = false;

    if (path.endsWith(".combine")) return nested;
    return undefined; // default merge
  };

  const outerBase = '{"combine":{"old":true},"a":1,"deep":{"b":2},"last":{"m":1}}';
  const outerIncoming = '{"combine":{"new":true},"deep":{"c":3},"last":{"n":2}}';
  const out = mergeJson(outerBase, outerIncoming, { overrideCb: outerCb });

  assert.ok(out, "outer merge returned null");
  const parsed = JSON.parse(out);
  // "combine" was replaced by the nested merge result.
  assert.deepStrictEqual(parsed.combine, JSON.parse(innerExpected),
    `combine key must equal nested merge result: ${out}`);
  // Default merge still applied to the other conflicting keys, meaning the
  // outer callback kept firing correctly AFTER nested merges ran.
  assert.deepStrictEqual(parsed.deep, { b: 2, c: 3 }, out);
  assert.deepStrictEqual(parsed.last, { m: 1, n: 2 }, out);
  assert.strictEqual(parsed.a, 1, out);
  assert.ok(outerCalls >= 3,
    `outer callback should fire for every conflicting object key, got ${outerCalls}`);
  assert.ok(innerResultsOk, "a nested merge inside the override produced a wrong result");

  // After everything, the callback slot must be fully cleared: a plain
  // merge must not invoke any stale callback.
  const plain = mergeJson('{"p":1}', '{"p":2}');
  assert.strictEqual(plain, '{"p":2}', `stale callback leaked into plain merge: ${plain}`);

  console.log(`PASS reentrancy: override callback ran ${outerCalls} times, nested merges (with and without callbacks) correct, no slot leakage`);
}

const t0 = process.hrtime.bigint();
testWorkerThreadConcurrency()
  .then(() => {
    testReentrantOverrideCallback();
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    console.log(`All concurrency tests passed in ${ms.toFixed(0)} ms`);
  })
  .catch((err) => {
    console.error("FAIL:", err);
    process.exit(1);
  });
