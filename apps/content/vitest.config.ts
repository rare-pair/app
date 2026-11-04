import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// Tests run inside workerd against the Worker's fetch entry, a local R2 bucket, and Postgres
// from the global setup reached through a local Hyperdrive, as in production. The entry,
// compatibility date and bindings come from wrangler.jsonc, so the tests run the config that
// deploys.
export default defineConfig({
  // The plugin resolves a module workerd asks it for through this root config's SSR
  // environment: pg's require of pg-cloudflare needs the plugin's conditions here.
  ssr: { resolve: { conditions: ["workerd", "worker", "module", "browser"] } },
  plugins: [
    cloudflareTest(({ inject }) => ({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: { hyperdrives: { HYPERDRIVE: inject("databaseUrl") } },
    })),
  ],
  test: {
    globalSetup: ["./test/global-setup.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
