import { createDb } from "@archive/db";
import { putFragments, seedWork } from "@archive/db/seed";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Bindings } from "../src/env";
import app from "../src/index";
import { BASE, signIn } from "./helpers";

// Which Hyperdrive connection each path reads through (ARCHITECTURE, Connections). A local
// Hyperdrive has no cache, so this cannot see a stale read, only a read that goes through the
// wrong binding: each case breaks the other connection and drives the path. One database serves
// every test file in the run, so this file keeps to AO3 work IDs 42500 to 42599 and its own
// `example.test` emails. Text is synthetic.
const LIVE = 42501;
const TAG = "conn-tag";

/** A Hyperdrive whose connection string leads nowhere: a read through it throws. */
const unreachable: Hyperdrive = {
  ...env.HYPERDRIVE,
  connectionString: "postgresql://nobody:nobody@127.0.0.1:1/none",
};

async function fetchWith(path: string, bindings: Partial<Bindings>, cookie?: string) {
  const ctx = createExecutionContext();
  const res = await app.fetch(
    new Request(new URL(path, BASE), { redirect: "manual", headers: cookie ? { cookie } : {} }),
    { ...env, ...bindings },
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}

const db = createDb({ connectionString: env.HYPERDRIVE.connectionString, max: 1 });
let cookie: string;

beforeAll(async () => {
  const seeded = await seedWork(db, {
    ao3WorkId: LIVE,
    status: "live",
    title: "Conn title",
    rating: "General Audiences",
    tags: [{ type: "freeform", name: TAG }],
  });
  await putFragments(env.BUCKET, seeded.fragments);
  cookie = await signIn(`conn-${Date.now()}@example.test`, { acceptTerms: true });
});
afterAll(() => db.destroy());

describe("Hyperdrive connections", () => {
  // Each public page reads through the cached connection alone.
  it.each([
    ["the home page", "/"],
    ["a tag listing", `/tags/freeform/${TAG}`],
    ["search", "/search?q=conn"],
    ["the work page", `/works/${LIVE}`],
    ["a chapter", `/works/${LIVE}/chapters/1`],
    ["the whole work", `/works/${LIVE}/full`],
    ["the warnings screen", `/works/${LIVE}/warnings`],
  ])("Public pages read through the cached connection: %s", async (_name, path) => {
    const working = await fetchWith(path, {});
    expect(working.status).toBeLessThan(400);
    const uncachedBroken = await fetchWith(path, { HYPERDRIVE: unreachable });
    expect(uncachedBroken.status).toBe(working.status);
  });

  // Sessions, roles, moderation and uploads read through the uncached connection alone.
  it.each([
    ["my uploads", "/me/uploads", 200],
    ["the upload page", "/upload", 200],
    ["the report form", `/works/${LIVE}/report`, 200],
    ["the admin queue", "/admin", 404],
  ])(
    "Account and moderation paths read through the uncached connection: %s",
    async (_name, path, status) => {
      const res = await fetchWith(path, { HYPERDRIVE_CACHED: unreachable }, cookie);
      expect(res.status).toBe(status);
    },
  );
});
