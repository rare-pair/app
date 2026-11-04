import { rm } from "node:fs/promises";
import type { TestProject } from "vitest/node";
import { bundleWorker } from "./worker";

// Bundles the Worker once for the whole run (about 6 s a bundle), and gives every site the
// folder (`inject("workerBundle")` in site.ts). Removes it when the run ends.
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const bundle = await bundleWorker();
  project.provide("workerBundle", bundle);
  return () => rm(bundle, { recursive: true });
}

declare module "vitest" {
  export interface ProvidedContext {
    /** The folder holding the web Worker's bundle, from browser/harness/global-setup.ts. */
    workerBundle: string;
  }
}
