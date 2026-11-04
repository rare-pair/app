import { rm } from "node:fs/promises";
import type { TestProject } from "vitest/node";
import { bundleWorkers, type WorkerBundles } from "./worker";

// Bundles the three Workers once for the whole run, side by side (web's takes about 6 s), and
// gives every site the folders (`inject("workerBundles")` in site.ts). Removes them when the
// run ends.
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const bundles = await bundleWorkers();
  project.provide("workerBundles", bundles);
  return async () => {
    await Promise.all(Object.values(bundles).map((bundle) => rm(bundle, { recursive: true })));
  };
}

declare module "vitest" {
  export interface ProvidedContext {
    /** The folders holding the Workers' bundles, from browser/harness/global-setup.ts. */
    workerBundles: WorkerBundles;
  }
}
