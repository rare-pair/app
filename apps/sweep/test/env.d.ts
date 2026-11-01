import type { Env as SweepEnv } from "../src/worker";

// The env the tests see from cloudflare:workers: the Worker's own bindings (wrangler.jsonc).
declare global {
  namespace Cloudflare {
    interface Env extends SweepEnv {}
  }
}
