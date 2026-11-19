import { seedWork } from "@archive/db/seed";
import { createDb } from "@archive/db";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import handler, { type Env } from "../src/index";
import { asNewClient } from "./client";

// SAFETY: the test env is the bindings wrangler.jsonc declares, which Env describes.
const E = env as Env;
const ORIGIN = "https://content.rarepair.fans";
// AO3 work id 43900 is this file's.
const AO3_ID = 43900;
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 5, 6, 7, 8]);

// SAFETY: the Worker calls only waitUntil on its context.
const ctx = {
  waitUntil: (p: Promise<unknown>) => void p.catch(() => undefined),
} as ExecutionContext;

const send = (path: string, init: RequestInit = {}, bindings: Env = { ...E, TOMBSTONE: "on" }) =>
  handler.fetch(new Request(`${ORIGIN}${path}`, asNewClient(init)), bindings, ctx);

describe("tombstone", () => {
  it("A file that would be served is a 410 with no body, never stored", async () => {
    const db = createDb({ connectionString: E.HYPERDRIVE.connectionString, max: 1 });
    const key = `works/${AO3_ID}/img/${"ab".repeat(32)}`;
    try {
      await seedWork(db, { ao3WorkId: AO3_ID });
    } finally {
      await db.destroy();
    }
    await E.BUCKET.put(key, PNG, { httpMetadata: { contentType: "image/png" } });

    // Served while open, so the 410 below is the tombstone's and not a missing file's.
    expect((await send(`/${key}`, {}, { ...E, TOMBSTONE: "off" })).status).toBe(200);

    for (const method of ["GET", "HEAD"]) {
      const res = await send(`/${key}`, { method });
      expect(res.status, method).toBe(410);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(await res.text()).toBe("");
    }
    expect((await send("/originals/anything.epub")).status).toBe(410);
    // A write is what it always was: this host serves reads only.
    expect((await send(`/${key}`, { method: "POST" })).status).toBe(405);
  });

  it("robots.txt is still served", async () => {
    const res = await send("/robots.txt");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Disallow: /");
  });

  it("A missing or misspelt TOMBSTONE keeps files closed; only off serves them", async () => {
    for (const TOMBSTONE of [undefined, "", "false", "OFF", "0"]) {
      const res = await send("/originals/anything.epub", {}, { ...E, TOMBSTONE });
      expect(res.status, String(TOMBSTONE)).toBe(410);
    }
  });
});
