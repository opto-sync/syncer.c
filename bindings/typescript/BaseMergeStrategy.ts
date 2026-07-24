/** "$.users[0].profile.name" -> "name"; "$.tags[3]" -> "tags"; "$" -> "$" */
export function lastPathSegment(jsonPath: string): string {
  const noIndex = jsonPath.replace(/\[\d+\]$/, '');
  const lastDot = noIndex.lastIndexOf('.');
  return lastDot >= 0 ? noIndex.slice(lastDot + 1) : noIndex;
}

export abstract class BaseMergeStrategy<T> {
  // Common methods all strategies share
  abstract handleConflict(key: keyof T | string, v1: any, v2: any): any;

  /**
   * Adapt this strategy to the native engine's callback contract.
   *
   * The native addon invokes the override with (jsonPath, v1Json, v2Json) —
   * the full path (e.g. "$.profile.tags") and both sides as JSON STRINGS —
   * and only accepts a JSON string (or undefined) back. handleConflict keeps
   * its ergonomic (key, parsedV1, parsedV2) => value signature, so ORM
   * plugins must bridge through this adapter; binding handleConflict directly
   * as the callback never matches (path !== key) and its non-string return
   * values are silently discarded.
   */
  toNativeCallback(): (jsonPath: string, v1: string, v2: string) => string | undefined {
    return (jsonPath, v1, v2) => {
      let p1: any;
      let p2: any;
      try {
        p1 = JSON.parse(v1);
        p2 = JSON.parse(v2);
      } catch {
        return undefined; // unparseable side: let the C default logic decide
      }
      const result = this.handleConflict(lastPathSegment(jsonPath) as keyof T, p1, p2);
      return result === undefined || result === null ? undefined : JSON.stringify(result);
    };
  }
}

// Example usage that the user would write:
export class UserProfileMerger extends BaseMergeStrategy<any> {

  handleConflict(key: string, v1: any, v2: any): any {
    switch (key) {
      case 'tags':
        // Overwrite array merge strategy: combine arrays
        return [...new Set([...v1, ...v2])];
      case 'embedding':
        // Custom math for vectors
        return v1.map((val: number, i: number) => (val + v2[i]) / 2);
      default:
        // Return undefined to tell the C core to use the default strategy
        return undefined;
    }
  }
}
