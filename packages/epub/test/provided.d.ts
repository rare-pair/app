import "vitest";
import type { Expected } from "./expected";

declare module "vitest" {
  export interface ProvidedContext {
    /** Epubs from fixtures/epubs/synthetic/ and fixtures/epubs/, base64 by file name. */
    epubFixtures: Record<string, string>;
    /** Names in epubFixtures that come from fixtures/epubs/synthetic/. */
    epubSyntheticNames: string[];
    /** fixtures/epubs/expected.json by epub file name. Empty when the file is absent. */
    epubExpected: Record<string, Expected>;
  }
}
