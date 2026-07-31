/**
 * Shared reconciliation fixtures + an integration-test policy.
 *
 * Every ORM plugin test drives the SAME base/incoming pair through a different
 * ORM and asserts the SAME expected document, so a divergence is a plugin bug
 * rather than a fixture difference.
 */
import { ArrayStrategy } from '../../../bindings/typescript';
import { BaseMergeStrategy } from '../../../bindings/typescript/BaseMergeStrategy';

/**
 * The canonical merge policy — identical to the default used by every
 * opto-sync client and server.
 *
 * There is deliberately NO `fwwKeys`. FWW in the C core is a node-level VETO,
 * not field protection: an incoming node whose FWW key is NEWER is discarded
 * WHOLESALE, however new its `updatedAt` is. With `createdAt` as a default FWW
 * key, any replica that ends up holding a later `createdAt` for a record could
 * never write that record again — silently, behind a 200 OK. See
 * docs/MERGE_SEMANTICS.md.
 */
export const POLICY = {
  arrayStrategy: ArrayStrategy.MERGE_BY_KEY, // 4
  arrayMatchKeys: 'id',
  resolveByTimestamp: true,
  lwwKeys: 'updatedAt,syncedAt',
} as const;

/**
 * The same policy with FWW explicitly opted into, used by the tests that assert
 * FWW *behaviour*. FWW remains fully supported — it is just not a default.
 */
export const FWW_POLICY = {
  ...POLICY,
  fwwKeys: 'createdAt',
} as const;

/** A no-op strategy: always defers to the C core's default resolution. */
export class PassthroughStrategy extends BaseMergeStrategy<any> {
  handleConflict(): any {
    return undefined;
  }
}

/**
 * A strategy that must demonstrably reach the C core.
 *
 * The override callback IS a universal hook as of core 0.2.1. Verified in
 * test/core-contract.test.ts:
 *   - consulted for scalar and object key conflicts at any depth, INCLUDING
 *     keys inside keyed-array elements that were matched and merged;
 *   - consulted for ARRAY-valued keys under every strategy, including UNION(2)
 *     and MERGE_BY_KEY(4). Before 0.2.1 arrays skipped it entirely under any
 *     non-REPLACE strategy, so an array override silently did nothing.
 * So this strategy deliberately targets a nested SCALAR (`accent`) and a scalar
 * INSIDE a keyed-array element (`qty`, summed like an additive counter).
 */
export class OverrideStrategy extends BaseMergeStrategy<any> {
  public calls: string[] = [];
  handleConflict(key: string, v1: any, v2: any): any {
    this.calls.push(String(key));
    if (key === 'accent') return `override(${v1}->${v2})`;
    if (key === 'qty') return Number(v1) + Number(v2); // additive counter
    return undefined;
  }
}

/**
 * Base (server-stored) document.
 *
 * NOTE ON SHAPE: the ROOT object intentionally carries no lww/fww key. With
 * resolveByTimestamp the core resolves an object WHOLESALE when both sides
 * share a timestamp key, so a root-level `updatedAt`/`createdAt` would gate the
 * entire document and mask the nested behaviour under test. Timestamps live at
 * exactly the level whose reconciliation is being asserted.
 */
export const BASE_DOC = {
  // plain deep merge (no timestamp keys anywhere in this subtree)
  profile: {
    name: 'Ada',
    theme: { mode: 'dark', accent: 'blue' },
    contact: { email: 'ada@example.com' },
  },
  // keyed-array reconciliation, per-element LWW on updatedAt
  items: [
    { id: 'a', qty: 1, note: 'base-a', updatedAt: '2026-06-01T00:00:00Z' },
    { id: 'b', qty: 2, note: 'base-b', updatedAt: '2026-06-01T00:00:00Z' },
  ],
  // FWW target: under the default policy this subtree is a plain deep merge;
  // only under FWW_POLICY does a re-creation attempt get vetoed.
  audit: { createdAt: '2026-01-01T00:00:00Z', actor: 'original-owner' },
  // custom-strategy targets
  tags: ['red', 'green'],
  embedding: [0, 10, 20],
};

/**
 * Incoming (client) document. Encodes four distinct conflicts:
 *  1. profile.theme.accent + profile.locale  -> plain deep merge
 *  2. items[id=a] is STALE (older updatedAt)  -> must be REJECTED
 *     items[id=b] is FRESH (newer updatedAt)  -> must be APPLIED
 *     items[id=c] is NEW                      -> must be APPENDED
 *  3. audit.createdAt is NEWER (re-creation)  -> merged under POLICY,
 *     REJECTED wholesale only under FWW_POLICY
 *  4. tags / embedding                        -> only a custom strategy changes them
 */
export const INCOMING_DOC = {
  profile: {
    theme: { accent: 'red' },
    locale: 'en-GB',
  },
  items: [
    { id: 'a', qty: 999, note: 'STALE-a', updatedAt: '2025-01-01T00:00:00Z' },
    { id: 'b', qty: 42, note: 'fresh-b', updatedAt: '2026-07-01T00:00:00Z' },
    { id: 'c', qty: 7, note: 'new-c', updatedAt: '2026-07-01T00:00:00Z' },
  ],
  audit: { createdAt: '2030-01-01T00:00:00Z', actor: 'impostor' },
  tags: ['blue'],
  embedding: [100, 100, 100],
};

/** Expected result of POLICY-merging INCOMING_DOC onto BASE_DOC (no override). */
export const EXPECTED_MERGED = {
  profile: {
    name: 'Ada', // preserved (deep merge, not replaced)
    theme: { mode: 'dark', accent: 'red' }, // mode preserved, accent taken
    contact: { email: 'ada@example.com' }, // untouched nested subtree preserved
    locale: 'en-GB', // new nested key added
  },
  items: [
    // id=a REJECTED wholesale: stale updatedAt
    { id: 'a', qty: 1, note: 'base-a', updatedAt: '2026-06-01T00:00:00Z' },
    // id=b APPLIED: newer updatedAt
    { id: 'b', qty: 42, note: 'fresh-b', updatedAt: '2026-07-01T00:00:00Z' },
    // id=c APPENDED
    { id: 'c', qty: 7, note: 'new-c', updatedAt: '2026-07-01T00:00:00Z' },
  ],
  // No FWW in the default policy, and no lww key in this subtree, so `audit`
  // is a plain deep merge and the incoming values win.
  audit: { createdAt: '2030-01-01T00:00:00Z', actor: 'impostor' },
  // MERGE_BY_KEY on non-object elements behaves like UNION (dedup + append)
  tags: ['red', 'green', 'blue'],
  embedding: [0, 10, 20, 100],
};

/**
 * Expected result of FWW_POLICY-merging INCOMING_DOC onto BASE_DOC. Identical
 * to EXPECTED_MERGED except that the `audit` subtree is vetoed WHOLESALE — both
 * keys, not just `createdAt` — which is exactly why FWW is not a default.
 */
export const EXPECTED_MERGED_FWW = {
  ...EXPECTED_MERGED,
  audit: { createdAt: '2026-01-01T00:00:00Z', actor: 'original-owner' },
};

/** Expected result when OverrideStrategy is in play. */
export const EXPECTED_MERGED_WITH_OVERRIDE = {
  ...EXPECTED_MERGED,
  profile: {
    ...EXPECTED_MERGED.profile,
    theme: { mode: 'dark', accent: 'override(blue->red)' },
  },
  items: [
    // still rejected wholesale — the override never sees its keys
    { id: 'a', qty: 1, note: 'base-a', updatedAt: '2026-06-01T00:00:00Z' },
    // qty summed by the JS callback: 2 + 42
    { id: 'b', qty: 44, note: 'fresh-b', updatedAt: '2026-07-01T00:00:00Z' },
    // appended, never a conflict
    { id: 'c', qty: 7, note: 'new-c', updatedAt: '2026-07-01T00:00:00Z' },
  ],
};

export const BASE_RAW = JSON.stringify(BASE_DOC);
export const INCOMING_RAW = JSON.stringify(INCOMING_DOC);
