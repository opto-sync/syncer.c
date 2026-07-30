import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { join, resolve } from 'node:path';

const packageRoot = process.argv[2] ? resolve(process.argv[2]) : null;
if (!packageRoot) {
  throw new Error('usage: node scripts/zpkg-wasm-smoke.mjs <installed-package-root>');
}

const entry = join(packageRoot, 'index.mjs');
const binding = await import(pathToFileURL(entry).href);

await binding.initSyncer();
assert.equal(binding.isReady(), true);
assert.equal(binding.version(), '0.2.1');

const merged = JSON.parse(
  binding.mergeJson(
    JSON.stringify({ value: 1, left: true }),
    JSON.stringify({ value: 2, right: true }),
  ),
);
assert.deepEqual(merged, { value: 2, left: true, right: true });

console.log('installed WASM artifact initialized and merged JSON successfully');
