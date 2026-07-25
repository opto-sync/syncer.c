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
    // Convert from Database to JS object.
    //
    // node-postgres registers a type parser for json/jsonb (OIDs 114/3802) and
    // therefore hands us an ALREADY-PARSED value, not text. A blind
    // JSON.parse() here stringifies that object to "[object Object]" and throws
    // `SyntaxError: Unexpected token o in JSON at position 1` on every read.
    // Only parse when the driver actually gave us text (e.g. a driver with JSON
    // parsing disabled, or a `::text` projection).
    fromDriver(value: string | T): T {
      return typeof value === 'string' ? (JSON.parse(value) as T) : value;
    },
    // Convert from JS object to the driver representation.
    //
    // A string is passed through verbatim so the zero-deserialization path can
    // hand `performZeroDeserializationMerge`'s raw output straight to an
    // insert/update without a stringify -> parse -> stringify round trip.
    // Postgres casts the text parameter to jsonb on the way in.
    toDriver(value: T): string {
      return typeof value === 'string' ? value : JSON.stringify(value);
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
