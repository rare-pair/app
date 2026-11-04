import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// Two projects (/tdd, Rules of the loop): the delivery logic is pure and runs in Node;
// the queue handler needs workerd and its queue APIs.
// The compatibility date must not be newer than the installed workerd.
export default defineConfig({
  test: {
    testTimeout: 60_000,
    projects: [
      {
        test: {
          name: "node",
          include: ["test/**/*.node.test.ts"],
          environment: "node",
        },
      },
      {
        plugins: [
          cloudflareTest({
            main: "./src/worker.ts",
            miniflare: {
              compatibilityDate: "2026-08-01",
              queueConsumers: ["email", "email-bulk"],
              // No test reaches a real provider: a fetch that a test didn't stub gets this.
              outboundService: () =>
                new Response("outbound network blocked in tests", { status: 599 }),
              bindings: {
                // Throwaway test values, not credentials.
                RESEND_API_KEY: "re_test_not_a_real_key",
                MAIL_FROM: "rarepair <sign-in@mail.example.test>",
                BULK_INTERVAL_SECONDS: "0",
              },
            },
          }),
        ],
        test: {
          name: "workers",
          include: ["test/**/*.worker.test.ts"],
        },
      },
    ],
  },
});
