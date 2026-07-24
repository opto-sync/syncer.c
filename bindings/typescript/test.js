// Assertion-based smoke tests for the Node-API binding to syncer.c.
// NOTE: the override callback receives the FULL JSON path (e.g. "$.override"),
// never the bare key — an equality check against a key name never fires.
const assert = require('node:assert');
const { mergeJson } = require('./index.js');

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

if (failures > 0) {
  console.log(`\n${failures} test(s) failed.`);
  process.exit(1);
}
console.log('\nAll binding tests passed.');
