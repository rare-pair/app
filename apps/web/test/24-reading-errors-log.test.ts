import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import app from "../src/index";
import { consoleDuring } from "./helpers";

// AO3 work ids 8812000-8812099 are this file's.
const W = 8812001;

// A database that refuses the connection: the reading handler throws, and onError answers 500.
const broken = { connectionString: "postgresql://nobody:none@127.0.0.1:1/none" };

async function failingRead(path: string) {
  let status = 0;
  const lines = await consoleDuring(async () => {
    const ctx = createExecutionContext();
    const res = await app.fetch(
      new Request(`https://rarepair.fans${path}`),
      // SAFETY: only connectionString is read from the bindings.
      { ...env, HYPERDRIVE: broken as Hyperdrive, HYPERDRIVE_CACHED: broken as Hyperdrive },
      ctx,
    );
    status = res.status;
    await waitOnExecutionContext(ctx);
  });
  return { status, lines };
}

describe("24-crawler-and-agent-blocking", () => {
  it("Counting refusals does not log what people read: a failing chapter page", async () => {
    const { status, lines } = await failingRead(`/works/${W}/chapters/3`);
    expect(status).toBe(500);
    // The fault is still logged, so an operator can see it happened.
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).not.toContain(String(W));
      expect(line).not.toContain("/chapters/3");
    }
    // What stays is the route and the kind of error.
    expect(lines.some((line) => line.includes("GET /works/:id/chapters/:n: "))).toBe(true);
  });

  it("Counting refusals does not log what people read: a failing entire-work page", async () => {
    const { status, lines } = await failingRead(`/works/${W}/full`);
    expect(status).toBe(500);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(line).not.toContain(String(W));
    expect(lines.some((line) => line.includes("GET /works/:id/full: "))).toBe(true);
  });
});
