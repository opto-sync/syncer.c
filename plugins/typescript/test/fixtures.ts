/**
 * Shared reconciliation fixtures + the canonical opto-sync merge policy.
 *
 * Every ORM plugin test drives the SAME base/incoming pair through a different
 * ORM and asserts the SAME expected document, so a divergence is a plugin bug
 * rather than a fixture difference.
 */
import { ArrayStrategy } from '../../../bindings/typescript';
import { BaseMergeStrategy } from '../../../bindings/typescript/BaseMergeStrategy';

/** The canonical policy used across every opto-sync language binding. */
export const POLICY = {
  arrayStrategy: ArrayStrategy.MERGE_BY_KEY, // 4
  arrayMatchKeys: 'id',
  resolveByTimestamp: true,
  lwwKeys: 'updatedAt,syncedAt',
  fwwKeys: 'createdAt',
} as const;

/** A no-op strategy: always defers to the C core's default resolution. */
export class PassthroughStrategy extends BaseMergeStrategy<any> {
  handleConflict(): any {
    return undefined;
  }
}

/**
 * A strategy that must demonstrably reach the C core: it unions the `tags`
 * array (overriding whatever the configured arrayStrategy would do) and
 * averages the `embedding` vector.
 */
export class OverrideStrategy extends BaseMergeStrategy<any> {
  public calls: string[] = [];
  handleConflict(key: string, v1: any, v2: any): any {
    this.calls.push(String(key));
    if (key === 'tags') return [...new Set([...(v1 ?? []), ...(v2 ?? [])])].sort();
    if (key === 'embedding') {
      return (v1 as number[]).map((val, i) => (val + (v2 as number[])[i]) / 2);
    }
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
  // FWW: a re-creation attempt must not overwrite this subtree
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
 *  3. audit.createdAt is NEWER (re-creation)  -> FWW must REJECT the subtree
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
  // FWW: incoming createdAt is NEWER, so the whole audit subtree is rejected
  audit: { createdAt: '2026-01-01T00:00:00Z', actor: 'original-owner' },
  // MERGE_BY_KEY on non-object elements behaves like UNION
  tags: ['red', 'green', 'blue'],
  embedding: [100, 100, 100],
};

/** Expected result when OverrideStrategy is in play. */
export const EXPECTED_MERGED_WITH_OVERRIDE = {
  ...EXPECTED_MERGED,
  tags: ['blue', 'green', 'red'], // union + sort, from the JS callback
  embedding: [50, 55, 60], // (base + incoming) / 2, from the JS callback
};

export const BASE_RAW = JSON.stringify(BASE_DOC);
export const INCOMING_RAW = JSON.stringify(INCOMING_DOC);
