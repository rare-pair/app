import "vitest";

declare module "vitest" {
  export interface ProvidedContext {
    /** The migrated test database's connection string, from test/global-setup.ts. */
    databaseUrl: string;
    /** Spec 12's hostile PDF, 261 KB inflating to 256 MB, from test/global-setup.ts. */
    inflateBombBase64: string;
  }
}
