import type { Bindings } from "../src/env";

// The env the tests see from cloudflare:workers: the Worker's own bindings (wrangler.jsonc).
declare global {
  namespace Cloudflare {
    interface Env extends Bindings {
      /** Test only: what the `email` queue delivered, from vitest.config.ts's email-sink. */
      EMAIL_SINK: Fetcher;
      /** Test only: what the `ingest` queue delivered, from vitest.config.ts's ingest-sink. */
      INGEST_SINK: Fetcher;
    }
  }
}
