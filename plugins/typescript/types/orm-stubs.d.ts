/**
 * Minimal STRUCTURAL type stubs for the ORM packages the plugins integrate
 * with. The real packages are peer dependencies of the consuming app and are
 * intentionally NOT installed here; these declarations exist only so
 * `tsc --noEmit` can type-check the plugins. They model just the surface the
 * plugins actually touch.
 */

declare module 'drizzle-orm/pg-core' {
  export function customType<T extends { data: unknown; driverData?: unknown }>(config: {
    dataType(): string;
    fromDriver?(value: T['driverData']): T['data'];
    toDriver?(value: T['data']): T['driverData'];
  }): (name: string) => unknown;
}

declare module '@prisma/client/extension' {
  export const Prisma: {
    defineExtension(extension: unknown): unknown;
    getExtensionContext(that: unknown): unknown;
  };
}

declare module 'kysely' {
  export interface RawBuilder<T> {
    as(alias: string): unknown;
    /** phantom member so T is used structurally */
    readonly __type?: T;
  }

  export const sql: (<T = unknown>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) => RawBuilder<T>) & {
    ref(reference: string): unknown;
  };

  /** Structural stand-in for the Kysely query builder root. */
  export interface Kysely<DB> {
    selectFrom(table: keyof DB | string): any;
    updateTable(table: keyof DB | string): any;
  }
}
