import { createDb } from "@archive/db";
import { putFragments, seedWork } from "@archive/db/seed";
import { env } from "cloudflare:workers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { expectAgentNotice } from "./agent-notice";
import { fetchW } from "./helpers";

// Runs with PRELAUNCH off. AO3 work ids 24500-24599 are this file's. Text is a synthetic marker.
const W = 24501;
const db = createDb({ connectionString: env.HYPERDRIVE.connectionString, max: 1 });

beforeAll(async () => {
  const work = await seedWork(db, {
    ao3WorkId: W,
    title: "Agent notice work",
    tags: [{ type: "rating", name: "agent-notice-General Audiences" }],
    chapters: [{ title: "One", html: "<p>AGENT-NOTICE-TEXT</p>" }],
  });
  await putFragments(env.BUCKET, work.fragments);
});
afterAll(async () => {
  await db.destroy();
});

describe("24-crawler-and-agent-blocking", () => {
  it.each([
    ["/", 200],
    ["/about", 200],
    ["/terms", 200],
    ["/no-such-page", 404],
    [`/works/${W}`, 200],
    [`/works/${W}/chapters/1`, 200],
    // Streamed, so it builds its page in pieces rather than through layout().
    [`/works/${W}/full`, 200],
  ])("Every page asks agents not to crawl: %s", async (path, status) => {
    const res = await fetchW(path);
    expect(res.status).toBe(status);
    expectAgentNotice(await res.text());
  });
});
