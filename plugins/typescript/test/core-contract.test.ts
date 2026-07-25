/**
 * Pins the parts of the core v0.2.0 contract that the ORM plugins (and the
 * BaseMergeStrategy adapter) depend on. No database involved — these are the
 * invariants the DB-backed tests assume, so if the core changes shape the
 * failure points here instead of looking like an ORM bug.
 */
import { mergeJson, version, ArrayStrategy } from '../../../bindings/typescript';
import { lastPathSegment } from '../../../bindings/typescript/BaseMergeStrategy';
import { POLICY, PassthroughStrategy, OverrideStrategy } from './fixtures';
import { suite, test, ok, equal, deepEqual } from './harness';

export async function register() {
  suite('core contract (assumptions the ORM plugins rely on)');

  test('core is v0.2.0 and exposes MERGE_BY_KEY = 4', async () => {
    equal(version(), '0.2.0', 'native core version');
    equal(ArrayStrategy.MERGE_BY_KEY, 4, 'MERGE_BY_KEY enum value');
    equal(POLICY.arrayStrategy, 4, 'canonical policy uses MERGE_BY_KEY');
  });

  test('object-level timestamp resolution is WHOLESALE, not per-key', async () => {
    // This is why the test fixtures keep the ROOT free of lww/fww keys.
    const stale = mergeJson(
      JSON.stringify({ updatedAt: '2026-06-01', keep: 1 }),
      JSON.stringify({ updatedAt: '2026-05-01', add: 2 }),
      POLICY as any,
    )!;
    deepEqual(JSON.parse(stale), { updatedAt: '2026-06-01', keep: 1 },
      'an older updatedAt rejects the ENTIRE incoming object, not just conflicting keys');

    const fresh = mergeJson(
      JSON.stringify({ updatedAt: '2026-05-01', keep: 1 }),
      JSON.stringify({ updatedAt: '2026-06-01', add: 2 }),
      POLICY as any,
    )!;
    deepEqual(JSON.parse(fresh), { updatedAt: '2026-06-01', keep: 1, add: 2 },
      'a newer updatedAt lets the deep merge proceed');

    const recreate = mergeJson(
      JSON.stringify({ createdAt: '2026-01-01', keep: 1 }),
      JSON.stringify({ createdAt: '2030-01-01', add: 2 }),
      POLICY as any,
    )!;
    deepEqual(JSON.parse(recreate), { createdAt: '2026-01-01', keep: 1 },
      'FWW: a newer createdAt rejects the ENTIRE incoming object');
  });

  test('override callback IS consulted for scalars/objects at any depth', async () => {
    const seen: string[] = [];
    const out = mergeJson(
      JSON.stringify({ a: { b: { c: 1 } } }),
      JSON.stringify({ a: { b: { c: 2 } } }),
      {
        ...POLICY,
        overrideCb: (p, v1, v2) => {
          seen.push(p);
          return p.endsWith('.c') ? JSON.stringify(JSON.parse(v1) + JSON.parse(v2)) : undefined;
        },
      } as any,
    )!;
    ok(seen.some((p) => p === '$.a.b.c'), 'callback receives the FULL json path');
    equal(JSON.parse(out).a.b.c, 3, 'override return value is honoured at depth 3');
  });

  test('override callback is NOT consulted for arrays under UNION/MERGE_BY_KEY', async () => {
    // Documented gap: the `UserProfileMerger` example in BaseMergeStrategy.ts
    // overrides `tags` and `embedding` (both arrays). Under the canonical
    // MERGE_BY_KEY policy that override never fires — the core reconciles arrays
    // itself. Plugin users must not rely on array overrides with this policy.
    for (const strategy of [ArrayStrategy.UNION, ArrayStrategy.MERGE_BY_KEY]) {
      const seen: string[] = [];
      const out = mergeJson(
        JSON.stringify({ tags: ['a'] }),
        JSON.stringify({ tags: ['b'] }),
        {
          arrayStrategy: strategy,
          overrideCb: (p, _v1, _v2) => {
            seen.push(p);
            return JSON.stringify(['OVERRIDDEN']);
          },
        } as any,
      )!;
      ok(!seen.includes('$.tags'), `arrayStrategy=${strategy}: callback NOT called for the array key`);
      deepEqual(JSON.parse(out).tags, ['a', 'b'], `arrayStrategy=${strategy}: core reconciled the array itself`);
    }

    // Under REPLACE (the default) the array override DOES fire.
    const seen: string[] = [];
    const out = mergeJson(
      JSON.stringify({ tags: ['a'] }),
      JSON.stringify({ tags: ['b'] }),
      {
        arrayStrategy: ArrayStrategy.REPLACE,
        overrideCb: (p) => {
          seen.push(p);
          return JSON.stringify(['OVERRIDDEN']);
        },
      } as any,
    )!;
    ok(seen.includes('$.tags'), 'arrayStrategy=REPLACE: callback IS called for the array key');
    deepEqual(JSON.parse(out).tags, ['OVERRIDDEN'], 'arrayStrategy=REPLACE: array override applies');
  });

  test('override callback fires for keys inside MATCHED keyed-array elements', async () => {
    const s = new OverrideStrategy();
    const out = mergeJson(
      JSON.stringify({ items: [{ id: 'b', qty: 2, updatedAt: '2026-01-01' }] }),
      JSON.stringify({ items: [{ id: 'b', qty: 40, updatedAt: '2026-02-01' }] }),
      { ...POLICY, overrideCb: s.toNativeCallback() } as any,
    )!;
    equal(JSON.parse(out).items[0].qty, 42, 'override summed qty inside the matched element');
    ok(s.calls.includes('qty'), 'handleConflict saw the inner key');
  });

  test('BaseMergeStrategy adapter maps json paths to bare keys', async () => {
    equal(lastPathSegment('$.users[0].profile.name'), 'name', 'nested key');
    equal(lastPathSegment('$.tags[3]'), 'tags', 'array index stripped');
    equal(lastPathSegment('$'), '$', 'root');
  });

  test('a passthrough strategy never alters the default resolution', async () => {
    const base = JSON.stringify({ a: 1, n: { x: 1 } });
    const inc = JSON.stringify({ a: 2, n: { y: 2 } });
    const withCb = mergeJson(base, inc, { ...POLICY, overrideCb: new PassthroughStrategy().toNativeCallback() } as any)!;
    const withoutCb = mergeJson(base, inc, POLICY as any)!;
    deepEqual(JSON.parse(withCb), JSON.parse(withoutCb), 'returning undefined defers to the core');
  });

  test('mergeJson returns null (not a throw) on invalid JSON', async () => {
    equal(mergeJson('{ bad', '{}', POLICY as any), null, 'invalid base');
    equal(mergeJson('{}', '{ bad', POLICY as any), null, 'invalid incoming');
    // every plugin must convert this null into a descriptive throw
  });
}
