import "vitest";

declare module "vitest" {
  export interface ProvidedContext {
    /** The migrated test database's connection string, from test/global-setup.ts. */
    databaseUrl: string;
  }
}
