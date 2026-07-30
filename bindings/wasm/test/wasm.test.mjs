/**
 * Test suite for the WebAssembly binding, run under Node against the same
 * committed dist/ artifacts a browser would load.
 *
 * Deliberately covers the same ground as bindings/typescript/test.js (the
 * N-API binding's suite): if the two bindings are to be drop-in
 * interchangeable, they have to be held to the same assertions.
 */
import test from 'node:test';
import assert from 'node:assert';
import { readFile } from 'node:fs/promises';

import {
  initSyncer,
  isReady,
  mergeJson,
  version,
  ArrayStrategy,
  heapAllocatedBytes,
  heapTotalBytes,
} from '../index.mjs';

/* One shared instantiation for the whole file — initSyncer() is idempotent, so
   this is also the happy-path proof that repeated calls are free. */
await initSyncer();

/* ------------------------------------------------------------------ */
/*  Init / identity                                                    */
/* ------------------------------------------------------------------ */

test('version() reports a >=0.2.1 core', () => {
  assert.match(version(), /^\d+\.\d+\.\d+$/);
  // Asserted as a lower bound so a patch bump does not fail the suite, but a
  // stale/mismatched core still does.
  const [maj, min, patch] = version().split('.').map(Number);
  assert.ok(maj > 0 || min > 2 || (min === 2 && patch >= 1), `unexpected core version ${version()}`);
});

test('initSyncer is idempotent and does not re-instantiate', async () => {
  assert.strictEqual(isReady(), true);
  const heapBefore = heapTotalBytes();
  const a = await initSyncer();
  const b = await initSyncer();
  // Concurrent callers must share the single in-flight instantiation too.
  const [c, d] = await Promise.all([initSyncer(), initSyncer()]);
  assert.strictEqual(a, b);
  assert.strictEqual(b, c);
  assert.strictEqual(c, d);
  assert.strictEqual(
    heapTotalBytes(),
    heapBefore,
    'a second instantiation would have allocated a whole new wasm memory',
  );
});

test('ArrayStrategy constant map matches the C enum', () => {
  assert.deepStrictEqual({ ...ArrayStrategy }, {
    REPLACE: 0,
    APPEND: 1,
    UNION: 2,
    MERGE_BY_INDEX: 3,
    MERGE_BY_KEY: 4,
  });
});

test('invalid array strategies fail loudly instead of silently keeping the base array', () => {
  for (const invalid of [-1, 5, 1.5, NaN, Infinity, '4']) {
    assert.throws(
      () => mergeJson('{"a":[1]}', '{"a":[2]}', { arrayStrategy: invalid }),
      /arrayStrategy must be an integer from 0 through 4/,
    );
  }
});

test('malformed scalar options fail instead of being coerced or ignored', () => {
  for (const maxDepth of [-1, 1.5, NaN, Infinity, 0x100000000, '1']) {
    assert.throws(
      () => mergeJson('{}', '{}', { maxDepth }),
      /maxDepth must be an integer from 0 through 4294967295/,
    );
  }
  assert.throws(
    () => mergeJson('{}', '{}', { resolveByTimestamp: 1 }),
    /resolveByTimestamp must be a boolean/,
  );
  assert.throws(
    () => mergeJson('{}', '{}', { lwwKeys: ['updatedAt'] }),
    /lwwKeys must be a string/,
  );
  assert.throws(
    () => mergeJson('{}', '{}', { arrayMatchKeys: 'id\0fallback' }),
    /arrayMatchKeys may not contain a NUL byte/,
  );
  assert.strictEqual(mergeJson('{}\0{"smuggled":true}', '{}'), null);
});

/* ------------------------------------------------------------------ */
/*  Core merge behaviour                                               */
/* ------------------------------------------------------------------ */

test('deep merge preserves siblings and applies incoming keys', () => {
  const out = mergeJson('{"a":1,"b":{"c":2}}', '{"b":{"d":3}}');
  assert.deepStrictEqual(JSON.parse(out), { a: 1, b: { c: 2, d: 3 } });
});

test('nested JSON-Pointer timestamp selectors execute inside the compiled wasm core', () => {
  const out = mergeJson(
    '{"_sync":{"updatedAt":200},"value":"base"}',
    '{"_sync":{"updatedAt":100},"value":"stale"}',
    {
      resolveByTimestamp: true,
      lwwKeys: '#/_sync/updatedAt',
    },
  );
  assert.strictEqual(JSON.parse(out).value, 'base');
});

test('invalid JSON returns null (not a throw)', () => {
  assert.strictEqual(mergeJson('{oops', '{}'), null);
  assert.strictEqual(mergeJson('{}', '{oops'), null);
  assert.strictEqual(mergeJson('', '{}'), null);
});

test('non-string inputs are a TypeError, as in the Node binding', () => {
  assert.throws(() => mergeJson(null, '{}'), TypeError);
  assert.throws(() => mergeJson('{}', 42), TypeError);
});

/* ------------------------------------------------------------------ */
/*  All five array strategies                                          */
/* ------------------------------------------------------------------ */

test('array strategy REPLACE (default): incoming array wins wholesale', () => {
  assert.deepStrictEqual(JSON.parse(mergeJson('{"a":[1,2,3]}', '{"a":[9]}')).a, [9]);
  const explicit = mergeJson('{"a":[1,2,3]}', '{"a":[9]}', {
    arrayStrategy: ArrayStrategy.REPLACE,
  });
  assert.deepStrictEqual(JSON.parse(explicit).a, [9]);
});

test('array strategy APPEND: incoming elements concatenated', () => {
  const out = mergeJson('{"a":[1,2]}', '{"a":[2,3]}', { arrayStrategy: ArrayStrategy.APPEND });
  assert.deepStrictEqual(JSON.parse(out).a, [1, 2, 2, 3]);
});

test('array strategy UNION: only new elements appended (idempotent)', () => {
  const out = mergeJson('{"a":[1,2]}', '{"a":[2,3]}', { arrayStrategy: ArrayStrategy.UNION });
  assert.deepStrictEqual(JSON.parse(out).a, [1, 2, 3]);
  const again = mergeJson(out, '{"a":[2,3]}', { arrayStrategy: ArrayStrategy.UNION });
  assert.deepStrictEqual(JSON.parse(again).a, [1, 2, 3]);
});

test('array strategy MERGE_BY_INDEX: element-wise deep merge', () => {
  const out = mergeJson('{"a":[{"x":1,"y":1},{"x":2}]}', '{"a":[{"y":9}]}', {
    arrayStrategy: ArrayStrategy.MERGE_BY_INDEX,
  });
  assert.deepStrictEqual(JSON.parse(out).a, [{ x: 1, y: 9 }, { x: 2 }]);
});

test('array strategy MERGE_BY_KEY: match by id, merge, append, keep', () => {
  const out = mergeJson(
    '{"items":[{"id":1,"name":"alpha","qty":5},{"id":2,"name":"beta"}]}',
    '{"items":[{"id":1,"qty":7},{"id":3,"name":"gamma"}]}',
    { arrayStrategy: ArrayStrategy.MERGE_BY_KEY },
  );
  assert.deepStrictEqual(JSON.parse(out).items, [
    { id: 1, name: 'alpha', qty: 7 },
    { id: 2, name: 'beta' },
    { id: 3, name: 'gamma' },
  ]);
});

test('MERGE_BY_KEY: numeric id 42 matches string id "42"', () => {
  const rows = JSON.parse(
    mergeJson('{"rows":[{"id":42,"v":"old"}]}', '{"rows":[{"id":"42","v":"new"}]}', {
      arrayStrategy: ArrayStrategy.MERGE_BY_KEY,
    }),
  ).rows;
  assert.strictEqual(rows.length, 1, 'no duplicate row');
  assert.strictEqual(rows[0].v, 'new');
});

test('MERGE_BY_KEY: non-object / id-less elements get UNION semantics', () => {
  const arr = JSON.parse(
    mergeJson(
      '{"arr":[1,{"note":"free"},{"id":1,"v":"a"}]}',
      '{"arr":[1,2,{"note":"free"},{"id":1,"v":"b"}]}',
      { arrayStrategy: ArrayStrategy.MERGE_BY_KEY },
    ),
  ).arr;
  assert.strictEqual(arr.filter((e) => e === 1).length, 1, 'scalar 1 not duplicated');
  assert.strictEqual(arr.filter((e) => e === 2).length, 1, 'new scalar 2 appended');
  assert.strictEqual(arr.filter((e) => e && e.note === 'free').length, 1);
  assert.strictEqual(arr.find((e) => e && e.id === 1).v, 'b');
});

/* ------------------------------------------------------------------ */
/*  arrayMatchKeys / LWW / FWW                                         */
/* ------------------------------------------------------------------ */

test('arrayMatchKeys "uuid,id": uuid is identity when present, id as fallback', () => {
  const rows = JSON.parse(
    mergeJson(
      '{"rows":[{"uuid":"u-1","v":1},{"id":7,"v":2}]}',
      '{"rows":[{"uuid":"u-1","v":10},{"id":7,"v":20}]}',
      { arrayStrategy: ArrayStrategy.MERGE_BY_KEY, arrayMatchKeys: 'uuid,id' },
    ),
  ).rows;
  assert.strictEqual(rows.length, 2, 'no duplicates');
  assert.strictEqual(rows.find((r) => r.uuid === 'u-1').v, 10);
  assert.strictEqual(rows.find((r) => r.id === 7).v, 20);
});

test('MERGE_BY_KEY + per-element LWW with reordered elements', () => {
  const rows = JSON.parse(
    mergeJson(
      '{"rows":[{"id":"a","updatedAt":200,"val":"base-a"},{"id":"b","updatedAt":100,"val":"base-b"}]}',
      '{"rows":[{"id":"b","updatedAt":150,"val":"new-b"},{"id":"a","updatedAt":100,"val":"stale-a"}]}',
      {
        arrayStrategy: ArrayStrategy.MERGE_BY_KEY,
        resolveByTimestamp: true,
        lwwKeys: 'updatedAt,syncedAt',
      },
    ),
  ).rows;
  assert.strictEqual(rows.find((r) => r.id === 'a').val, 'base-a', 'stale element rejected');
  assert.strictEqual(rows.find((r) => r.id === 'b').val, 'new-b', 'fresh element accepted');
});

test('fwwKeys: incoming element claiming a later createdAt is rejected', () => {
  const rows = JSON.parse(
    mergeJson(
      '{"rows":[{"id":1,"createdAt":100,"who":"original"}]}',
      '{"rows":[{"id":1,"createdAt":300,"who":"impostor"}]}',
      { arrayStrategy: ArrayStrategy.MERGE_BY_KEY, resolveByTimestamp: true, fwwKeys: 'createdAt' },
    ),
  ).rows;
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].who, 'original');
  assert.strictEqual(rows[0].createdAt, 100);
});

test('CRDT: numeric-string timestamps compare by magnitude, not strcmp', () => {
  const out = mergeJson('{"updatedAt":"10","val":"base"}', '{"updatedAt":"9","val":"stale"}', {
    resolveByTimestamp: true,
    lwwKeys: 'updatedAt',
  });
  assert.strictEqual(JSON.parse(out).val, 'base', 'older stamp "9" must not beat "10"');
});

test('lwwKeys: absent (undefined) and empty-string are DIFFERENT options', () => {
  // The core reads a NULL lww_keys as "updatedAt" and "" as "no LWW keys at
  // all". A wrapper that collapsed '' to NULL would silently re-enable the
  // default guard; one that collapsed undefined to '' would silently disable
  // it. Both are invisible without this test.
  const j1 = '{"updatedAt":200,"val":"base"}';
  const j2 = '{"updatedAt":100,"val":"stale"}';
  const implicitDefault = mergeJson(j1, j2, { resolveByTimestamp: true });
  assert.strictEqual(JSON.parse(implicitDefault).val, 'base', 'undefined => core default updatedAt');
  const noKeys = mergeJson(j1, j2, { resolveByTimestamp: true, lwwKeys: '' });
  assert.strictEqual(JSON.parse(noKeys).val, 'stale', '"" => no LWW keys, incoming applies');
});

/* ------------------------------------------------------------------ */
/*  maxDepth                                                           */
/* ------------------------------------------------------------------ */

test('maxDepth: nested objects below the limit are replaced, not merged', () => {
  const unlimited = mergeJson('{"a":{"b":1,"c":2}}', '{"a":{"b":9}}');
  assert.deepStrictEqual(JSON.parse(unlimited).a, { b: 9, c: 2 });
  const capped = mergeJson('{"a":{"b":1,"c":2}}', '{"a":{"b":9}}', { maxDepth: 1 });
  assert.deepStrictEqual(JSON.parse(capped).a, { b: 9 }, 'incoming subtree wins wholesale');
});

/* ------------------------------------------------------------------ */
/*  Unicode + numeric fidelity across the JS <-> wasm boundary          */
/* ------------------------------------------------------------------ */

test('unicode keys, values and escapes survive the UTF-8 round trip', () => {
  const out = mergeJson(
    '{"héllo":{"wörld":1},"a.b":{"c":1},"q\\"k":1}',
    '{"héllo":{"wörld":2,"日本":3},"a.b":{"d":4},"q\\"k":9}',
  );
  const parsed = JSON.parse(out);
  assert.strictEqual(parsed['héllo']['wörld'], 2);
  assert.strictEqual(parsed['héllo']['日本'], 3);
  assert.strictEqual(parsed['a.b'].c, 1);
  assert.strictEqual(parsed['a.b'].d, 4);
  assert.strictEqual(parsed['q"k'], 9);
});

test('unicode identity values match under MERGE_BY_KEY', () => {
  const out = mergeJson('{"a":[{"id":"ключ","v":1}]}', '{"a":[{"id":"ключ","v":2}]}', {
    arrayStrategy: ArrayStrategy.MERGE_BY_KEY,
  });
  assert.deepStrictEqual(JSON.parse(out).a, [{ id: 'ключ', v: 2 }]);
});

test('astral-plane characters (surrogate pairs) survive intact', () => {
  // lengthBytesUTF8/stringToUTF8 must agree about 4-byte sequences or the
  // string is truncated mid-character.
  const emoji = '👨‍👩‍👧‍👦🧬';
  const out = mergeJson('{"x":"old"}', JSON.stringify({ x: emoji }));
  assert.strictEqual(JSON.parse(out).x, emoji);
});

test('int64 digit-string timestamps keep full precision (no double rounding)', () => {
  // Nanosecond epochs differing only in the final digit: a comparison routed
  // through a double would call these equal and let the stale side win.
  const out = mergeJson(
    '{"doc":{"updatedAt":1689940800123456789,"val":"base"}}',
    '{"doc":{"updatedAt":1689940800123456788,"val":"stale"}}',
    { resolveByTimestamp: true, lwwKeys: 'updatedAt' },
  );
  assert.match(out, /"val":"base"/);
  // The integer itself must be emitted verbatim, not as 1.68994080012345677e18.
  assert.match(out, /"updatedAt":1689940800123456789/);

  const negative = mergeJson(
    '{"doc":{"updatedAt":-50,"val":"base"}}',
    '{"doc":{"updatedAt":-100,"val":"stale"}}',
    { resolveByTimestamp: true, lwwKeys: 'updatedAt' },
  );
  assert.match(negative, /"val":"base"/);
});

test('large uint64-ish integers round-trip verbatim through the merge', () => {
  const out = mergeJson('{"a":1}', '{"big":9007199254740993,"neg":-9223372036854775807}');
  assert.match(out, /"big":9007199254740993/);
  assert.match(out, /"neg":-9223372036854775807/);
});

/* ------------------------------------------------------------------ */
/*  UNION structural dedup                                             */
/* ------------------------------------------------------------------ */

test('UNION dedup is key-order independent (jsonb reorders on every write)', () => {
  const same = mergeJson('{"arr":[{"id":"c","v":3}]}', '{"arr":[{"v":3,"id":"c"}]}', {
    arrayStrategy: ArrayStrategy.UNION,
  });
  assert.strictEqual(JSON.parse(same).arr.length, 1, 'reordered duplicate must not be appended');

  const nested = mergeJson(
    '{"arr":[{"id":1,"meta":{"a":1,"b":[1,2]},"z":true}]}',
    '{"arr":[{"z":true,"meta":{"b":[1,2],"a":1},"id":1}]}',
    { arrayStrategy: ArrayStrategy.UNION },
  );
  assert.strictEqual(JSON.parse(nested).arr.length, 1, 'nested reorder still deduped');

  const distinct = mergeJson('{"arr":[{"id":1,"v":1}]}', '{"arr":[{"v":2,"id":1}]}', {
    arrayStrategy: ArrayStrategy.UNION,
  });
  assert.strictEqual(JSON.parse(distinct).arr.length, 2, 'genuinely different element appended');
});

test('UNION keeps array element ORDER significant: [1,2] != [2,1]', () => {
  const out = mergeJson('{"arr":[[1,2]]}', '{"arr":[[2,1]]}', {
    arrayStrategy: ArrayStrategy.UNION,
  });
  assert.strictEqual(JSON.parse(out).arr.length, 2);
});

/* ------------------------------------------------------------------ */
/*  Override callback (JS function called from wasm)                    */
/* ------------------------------------------------------------------ */

test('override callback fires with the full JSON path', () => {
  const seen = [];
  const out = mergeJson('{"override":"no","keep":1}', '{"override":"yes"}', {
    overrideCb: (path) => {
      seen.push(path);
      return path === '$.override' ? '{"custom":"merged from JS!"}' : undefined;
    },
  });
  assert.ok(seen.includes('$.override'), `callback saw: ${seen.join(', ') || '(nothing)'}`);
  const parsed = JSON.parse(out);
  assert.deepStrictEqual(parsed.override, { custom: 'merged from JS!' });
  assert.strictEqual(parsed.keep, 1);
});

test('legacy positional callback still works', () => {
  const out = mergeJson('{"x":1}', '{"x":2}', (path) => (path === '$.x' ? '99' : undefined));
  assert.strictEqual(JSON.parse(out).x, 99);
});

test('a throwing override propagates as a JS exception', () => {
  assert.throws(
    () =>
      mergeJson('{"a":{"b":1}}', '{"a":{"b":2}}', {
        overrideCb: () => {
          throw new Error('kaboom');
        },
      }),
    /kaboom/,
  );
});

test('a throwing override stops further callbacks; defaults apply to the rest', () => {
  let calls = 0;
  assert.throws(
    () =>
      mergeJson('{"a":1,"b":2,"c":3}', '{"a":10,"b":20,"c":30}', {
        overrideCb: () => {
          calls++;
          throw new Error('first-key-boom');
        },
      }),
    /first-key-boom/,
  );
  assert.strictEqual(calls, 1, 'callback not invoked again after it threw');
});

test('reentrant mergeJson inside an override keeps both callbacks intact', () => {
  const out = mergeJson('{"outer":1}', '{"outer":2}', {
    overrideCb: (path) => {
      if (path !== '$.outer') return undefined;
      const inner = mergeJson('{"i":1}', '{"i":2}', {
        overrideCb: (p) => (p === '$.i' ? '42' : undefined),
      });
      assert.strictEqual(JSON.parse(inner).i, 42, 'inner override applied');
      return JSON.stringify(JSON.parse(inner).i + 1);
    },
  });
  assert.strictEqual(JSON.parse(out).outer, 43, 'outer override survived the reentrant call');
});

/* ------------------------------------------------------------------ */
/*  Memory hygiene                                                     */
/* ------------------------------------------------------------------ */

test('5000 merges leak neither the wasm heap nor the function table', () => {
  const base = JSON.stringify({
    id: 'doc-1',
    updatedAt: 1000,
    title: 'a reasonably long title so the strings are not tiny',
    tags: ['alpha', 'beta', 'gamma'],
    rows: Array.from({ length: 12 }, (_, i) => ({
      id: `r-${i}`,
      updatedAt: 1000 + i,
      body: 'x'.repeat(64),
    })),
  });
  const incoming = JSON.stringify({
    updatedAt: 2000,
    tags: ['beta', 'delta'],
    rows: Array.from({ length: 12 }, (_, i) => ({
      id: `r-${i}`,
      updatedAt: 2000 + i,
      body: 'y'.repeat(64),
    })),
    unicode: 'ключ 日本 👨‍👩‍👧‍👦',
  });
  const options = {
    arrayStrategy: ArrayStrategy.MERGE_BY_KEY,
    arrayMatchKeys: 'id',
    resolveByTimestamp: true,
    lwwKeys: 'updatedAt,syncedAt',
    fwwKeys: 'createdAt',
  };

  // Warm up so first-call allocations (heap arenas, table growth) are not
  // mistaken for a leak.
  for (let i = 0; i < 50; i++) mergeJson(base, incoming, options);
  const allocBaseline = heapAllocatedBytes();
  const totalBaseline = heapTotalBytes();

  for (let i = 0; i < 5000; i++) {
    const out = mergeJson(base, incoming, options);
    if (out === null) throw new Error(`merge failed at iteration ${i}`);
  }

  assert.strictEqual(
    heapAllocatedBytes(),
    allocBaseline,
    'every malloc made during a merge must be freed before it returns',
  );
  assert.strictEqual(
    heapTotalBytes(),
    totalBaseline,
    'wasm memory must not have had to grow across 5000 merges',
  );

  // Overrides allocate a table slot per call; removeFunction must recycle it.
  const cbOptions = { ...options, overrideCb: () => undefined };
  for (let i = 0; i < 50; i++) mergeJson(base, incoming, cbOptions);
  const cbAllocBaseline = heapAllocatedBytes();
  for (let i = 0; i < 1000; i++) mergeJson(base, incoming, cbOptions);
  assert.strictEqual(heapAllocatedBytes(), cbAllocBaseline, 'override path leaks nothing');
  assert.strictEqual(heapTotalBytes(), totalBaseline, 'override path did not grow memory');
});

test('a null return and a throwing override still free their inputs', () => {
  const baseline = heapAllocatedBytes();
  for (let i = 0; i < 500; i++) {
    assert.strictEqual(mergeJson('{not json', '{"a":1}'), null);
    try {
      mergeJson('{"a":1}', '{"a":2}', {
        overrideCb: () => {
          throw new Error('boom');
        },
      });
    } catch {
      /* expected */
    }
  }
  assert.strictEqual(heapAllocatedBytes(), baseline, 'error paths must not leak');
});

/* ------------------------------------------------------------------ */
/*  The split (separate .wasm) artifact                                */
/* ------------------------------------------------------------------ */

test('the split build produces identical results to the single-file build', async () => {
  const split = await import('../split.mjs');
  await split.initSyncer({ wasmBinary: await readFile(split.wasmUrl) });
  assert.strictEqual(split.version(), version());

  const corpus = [
    ['{"a":1,"b":{"c":2}}', '{"b":{"d":3}}', undefined],
    ['{"a":[1,2]}', '{"a":[2,3]}', { arrayStrategy: ArrayStrategy.UNION }],
    [
      '{"rows":[{"id":"a","updatedAt":200,"v":1}]}',
      '{"rows":[{"id":"a","updatedAt":100,"v":2}]}',
      { arrayStrategy: ArrayStrategy.MERGE_BY_KEY, resolveByTimestamp: true },
    ],
    ['{oops', '{}', undefined],
  ];
  for (const [j1, j2, opts] of corpus) {
    assert.strictEqual(split.mergeJson(j1, j2, opts), mergeJson(j1, j2, opts));
  }
});

test('the generated glue references no Node builtins (browser-loadable)', async () => {
  const forbidden = [
    /\brequire\s*\(/,
    /createRequire/,
    /["']node:/,
    /\bprocess\.binding\b/,
    /__dirname/,
    /\bnew\s+Buffer\b/,
    /\bBuffer\.from\b/,
  ];
  for (const file of ['syncer-core.mjs', 'syncer-core.single.mjs']) {
    const src = await readFile(new URL(`../dist/${file}`, import.meta.url), 'utf8');
    for (const re of forbidden) {
      assert.ok(!re.test(src), `${file} must not reference ${re}`);
    }
  }
});
