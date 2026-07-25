import { BaseMergeStrategy } from '../../../bindings/typescript/BaseMergeStrategy';
import { mergeJson, MergeOptions } from '../../../bindings/typescript';
import { customType } from 'drizzle-orm/pg-core';

/**
 * Merge options a plugin caller may tune. The override callback is always
 * derived from the strategy, so it is not part of the public surface.
 */
export type SyncerMergeOptions = Omit<MergeOptions, 'overrideCb'>;

/**
 * Creates a Drizzle custom JSONB type that automatically uses the
 * opto-sync C library for deep merging when conflicts arise in application-level syncs.
 *
 * @param strategy An instance of a class extending BaseMergeStrategy to handle manual overrides.
 */
export function syncedJsonb<T>(name: string, strategy: BaseMergeStrategy<T>) {
  return customType<{ data: T; driverData: string }>({
    dataType() {
      return 'jsonb';
    },
    // Convert from Database (string) to JS Object
    fromDriver(value: string): T {
      // Zero-deserialization approach: we delay parsing if we are just merging,
      // but Drizzle's fromDriver typically requires the final object.
      return JSON.parse(value);
    },
    // Convert from JS Object to Database (string)
    toDriver(value: T): string {
      return JSON.stringify(value);
    }
  })(name);
}

/**
 * A utility to merge two raw JSON strings using the provided strategy.
 * This is designed for offline-first sync endpoints where the server receives
 * a raw JSON payload, fetches the existing raw JSON from the DB, and merges them
 * BEFORE deserializing into a heavy JS object.
 *
 * @param options Optional merge tuning (arrayStrategy incl. MERGE_BY_KEY,
 *                arrayMatchKeys, maxDepth, detectCircularRefs,
 *                resolveByTimestamp, lwwKeys, fwwKeys) forwarded to the C core.
 */
export function performZeroDeserializationMerge<T>(
  rawDbJson: string,
  rawIncomingJson: string,
  strategy: BaseMergeStrategy<T>,
  options?: SyncerMergeOptions
): T {
  // Call the C core FFI synchronously
  // It stays as strings until the very end!
  const mergedString = mergeJson(rawDbJson, rawIncomingJson, {
    ...options,
    overrideCb: strategy.toNativeCallback(),
  });
  if (mergedString === null) {
    throw new Error('opto-sync merge failed: input was not valid JSON');
  }

  // Deserialize exactly once
  return JSON.parse(mergedString);
}
