// Assertion-based smoke tests for the Node-API binding to syncer.c.
// NOTE: the override callback receives the FULL JSON path (e.g. "$.override"),
// never the bare key — an equality check against a key name never fires.
const assert = require('node:assert');
const { mergeJson, version, ArrayStrategy } = require('./index.js');

let failures = 0;
function t(name, fn) {
  try {
    fn();
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failures++;
    console.log(`  FAIL  ${name}`);
    console.log(`        ${err.message}`);
  }
}

console.log('Testing JS Node-API Binding to syncer.c:');

t('deep merge preserves siblings and applies incoming keys', () => {
  const out = mergeJson('{"a":1,"b":{"c":2}}', '{"b":{"d":3}}');
  assert.deepStrictEqual(JSON.parse(out), { a: 1, b: { c: 2, d: 3 } });
});

t('override callback fires with the full JSON path', () => {
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

t('legacy positional callback still works', () => {
  const out = mergeJson('{"x":1}', '{"x":2}', (path) => (path === '$.x' ? '99' : undefined));
  assert.strictEqual(JSON.parse(out).x, 99);
});

t('CRDT: numeric-string timestamps compare by magnitude, not strcmp', () => {
  const out = mergeJson('{"updatedAt":"10","val":"base"}', '{"updatedAt":"9","val":"stale"}', {
    resolveByTimestamp: true,
    lwwKeys: 'updatedAt',
  });
  assert.strictEqual(JSON.parse(out).val, 'base', 'older stamp "9" must not beat "10"');
});

t('invalid JSON returns null', () => {
  assert.strictEqual(mergeJson('{oops', '{}'), null);
});

t('a throwing override propagates as a JS exception', () => {
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

t('reentrant mergeJson inside an override keeps both callbacks intact', () => {
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

t('version() reports the core library version', () => {
  const v = version();
  assert.match(v, /^\d+\.\d+\.\d+$/);
  const [maj, min, patch] = v.split('.').map(Number);
  assert.ok(maj > 0 || min > 2 || (min === 2 && patch >= 1), `unexpected core version ${v}`);
});

t('ArrayStrategy constant map matches the C enum', () => {
  assert.deepStrictEqual(ArrayStrategy, {
    REPLACE: 0,
    APPEND: 1,
    UNION: 2,
    MERGE_BY_INDEX: 3,
    MERGE_BY_KEY: 4,
  });
});

t('invalid array strategies fail loudly instead of silently keeping the base array', () => {
  for (const invalid of [-1, 5, 1.5, NaN, Infinity, '4']) {
    assert.throws(
      () => mergeJson('{"a":[1]}', '{"a":[2]}', { arrayStrategy: invalid }),
      /arrayStrategy must be an integer from 0 through 4/,
    );
  }
});

t('malformed scalar options fail instead of being coerced or ignored', () => {
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

t('array strategy REPLACE (default): incoming array wins wholesale', () => {
  const out = mergeJson('{"a":[1,2,3]}', '{"a":[9]}');
  assert.deepStrictEqual(JSON.parse(out).a, [9]);
  const explicit = mergeJson('{"a":[1,2,3]}', '{"a":[9]}', { arrayStrategy: ArrayStrategy.REPLACE });
  assert.deepStrictEqual(JSON.parse(explicit).a, [9]);
});

t('array strategy APPEND: incoming elements concatenated', () => {
  const out = mergeJson('{"a":[1,2]}', '{"a":[2,3]}', { arrayStrategy: ArrayStrategy.APPEND });
  assert.deepStrictEqual(JSON.parse(out).a, [1, 2, 2, 3]);
});

t('array strategy UNION: only new elements appended (idempotent)', () => {
  const out = mergeJson('{"a":[1,2]}', '{"a":[2,3]}', { arrayStrategy: ArrayStrategy.UNION });
  assert.deepStrictEqual(JSON.parse(out).a, [1, 2, 3]);
  const again = mergeJson(out, '{"a":[2,3]}', { arrayStrategy: ArrayStrategy.UNION });
  assert.deepStrictEqual(JSON.parse(again).a, [1, 2, 3]);
});

t('array strategy MERGE_BY_INDEX: element-wise deep merge', () => {
  const out = mergeJson('{"a":[{"x":1,"y":1},{"x":2}]}', '{"a":[{"y":9}]}', {
    arrayStrategy: ArrayStrategy.MERGE_BY_INDEX,
  });
  assert.deepStrictEqual(JSON.parse(out).a, [{ x: 1, y: 9 }, { x: 2 }]);
});

t('array strategy MERGE_BY_KEY: match by id, merge, append, keep', () => {
  const out = mergeJson(
    '{"items":[{"id":1,"name":"alpha","qty":5},{"id":2,"name":"beta"}]}',
    '{"items":[{"id":1,"qty":7},{"id":3,"name":"gamma"}]}',
    { arrayStrategy: ArrayStrategy.MERGE_BY_KEY },
  );
  assert.deepStrictEqual(JSON.parse(out).items, [
    { id: 1, name: 'alpha', qty: 7 }, // matched pair deep-merged
    { id: 2, name: 'beta' },          // existing-only element kept
    { id: 3, name: 'gamma' },         // unmatched incoming appended
  ]);
});

t('MERGE_BY_KEY: numeric id 42 matches string id "42"', () => {
  const out = mergeJson('{"rows":[{"id":42,"v":"old"}]}', '{"rows":[{"id":"42","v":"new"}]}', {
    arrayStrategy: ArrayStrategy.MERGE_BY_KEY,
  });
  const rows = JSON.parse(out).rows;
  assert.strictEqual(rows.length, 1, 'no duplicate row');
  assert.strictEqual(rows[0].v, 'new');
});

t('MERGE_BY_KEY: non-object / id-less elements get UNION semantics', () => {
  const out = mergeJson(
    '{"arr":[1,{"note":"free"},{"id":1,"v":"a"}]}',
    '{"arr":[1,2,{"note":"free"},{"id":1,"v":"b"}]}',
    { arrayStrategy: ArrayStrategy.MERGE_BY_KEY },
  );
  const arr = JSON.parse(out).arr;
  assert.strictEqual(arr.filter((e) => e === 1).length, 1, 'scalar 1 not duplicated');
  assert.strictEqual(arr.filter((e) => e === 2).length, 1, 'new scalar 2 appended');
  assert.strictEqual(arr.filter((e) => e && e.note === 'free').length, 1, 'id-less object not duplicated');
  assert.strictEqual(arr.find((e) => e && e.id === 1).v, 'b');
});

t('arrayMatchKeys "uuid,id": uuid is identity when present, id as fallback', () => {
  const out = mergeJson(
    '{"rows":[{"uuid":"u-1","v":1},{"id":7,"v":2}]}',
    '{"rows":[{"uuid":"u-1","v":10},{"id":7,"v":20}]}',
    { arrayStrategy: ArrayStrategy.MERGE_BY_KEY, arrayMatchKeys: 'uuid,id' },
  );
  const rows = JSON.parse(out).rows;
  assert.strictEqual(rows.length, 2, 'no duplicates');
  assert.strictEqual(rows.find((r) => r.uuid === 'u-1').v, 10);
  assert.strictEqual(rows.find((r) => r.id === 7).v, 20);
});

t('MERGE_BY_KEY + per-element LWW with reordered elements', () => {
  const out = mergeJson(
    '{"rows":[{"id":"a","updatedAt":200,"val":"base-a"},{"id":"b","updatedAt":100,"val":"base-b"}]}',
    '{"rows":[{"id":"b","updatedAt":150,"val":"new-b"},{"id":"a","updatedAt":100,"val":"stale-a"}]}',
    {
      arrayStrategy: ArrayStrategy.MERGE_BY_KEY,
      resolveByTimestamp: true,
      lwwKeys: 'updatedAt,syncedAt',
    },
  );
  const rows = JSON.parse(out).rows;
  assert.strictEqual(rows.find((r) => r.id === 'a').val, 'base-a', 'stale incoming element rejected');
  assert.strictEqual(rows.find((r) => r.id === 'b').val, 'new-b', 'fresh incoming element accepted');
});

t('fwwKeys: incoming element with LATER createdAt is rejected (First-Write-Wins)', () => {
  const out = mergeJson(
    '{"rows":[{"id":1,"createdAt":100,"who":"original"}]}',
    '{"rows":[{"id":1,"createdAt":300,"who":"impostor"}]}',
    { arrayStrategy: ArrayStrategy.MERGE_BY_KEY, resolveByTimestamp: true, fwwKeys: 'createdAt' },
  );
  const rows = JSON.parse(out).rows;
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].who, 'original');
  assert.strictEqual(rows[0].createdAt, 100);
});

t('maxDepth: nested objects below the limit are replaced, not merged', () => {
  const unlimited = mergeJson('{"a":{"b":1,"c":2}}', '{"a":{"b":9}}');
  assert.deepStrictEqual(JSON.parse(unlimited).a, { b: 9, c: 2 });
  const capped = mergeJson('{"a":{"b":1,"c":2}}', '{"a":{"b":9}}', { maxDepth: 1 });
  assert.deepStrictEqual(JSON.parse(capped).a, { b: 9 }, 'at max depth the incoming subtree wins wholesale');
});

t('a throwing override stops further callbacks; defaults apply to remaining keys', () => {
  let calls = 0;
  let caught = null;
  try {
    mergeJson('{"a":1,"b":2,"c":3}', '{"a":10,"b":20,"c":30}', {
      overrideCb: () => {
        calls++;
        throw new Error('first-key-boom');
      },
    });
  } catch (err) {
    caught = err;
  }
  assert.ok(caught, 'exception propagated to JS');
  assert.match(caught.message, /first-key-boom/);
  assert.strictEqual(calls, 1, 'callback not invoked again after it threw');
});

if (failures > 0) {
  console.log(`\n${failures} test(s) failed.`);
  process.exit(1);
}
console.log('\nAll binding tests passed.');
