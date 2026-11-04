// The bindings vitest.config.ts gives the Worker, typed for `env` from cloudflare:workers.
declare namespace Cloudflare {
  interface Env {
    RESEND_API_KEY: string;
    MAIL_FROM: string;
    BULK_INTERVAL_SECONDS: string;
  }
}

// vite's `?raw` import: the file's text. wrangler.node.test.ts reads wrangler.jsonc this way.
declare module "*.jsonc?raw" {
  const text: string;
  export default text;
}
