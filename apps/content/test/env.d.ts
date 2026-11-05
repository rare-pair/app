import type { Env as ContentEnv } from "../src/index";

// The env the tests see from cloudflare:workers: the Worker's own bindings (wrangler.jsonc).
declare global {
  namespace Cloudflare {
    interface Env extends ContentEnv {}
  }
}

// vite's `?raw` import: the file's text. wrangler.test.ts reads wrangler.jsonc this way.
declare module "*.jsonc?raw" {
  const text: string;
  export default text;
}
