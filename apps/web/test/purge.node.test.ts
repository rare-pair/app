import { describe, expect, it } from "vitest";
import { PurgeError, purgeWorkCaches, type PurgeCredentials } from "../src/purge";

// The purge's requests to Cloudflare's purge_cache API, against a stub `fetch`
// (https://developers.cloudflare.com/api/resources/cache/methods/purge/).
const TOKEN = "test-only-purge-token";
const ZONE = "0123456789abcdef0123456789abcdef";
const credentials = { token: TOKEN, zoneId: ZONE };
const PURGE_URL = `https://api.cloudflare.com/client/v4/zones/${ZONE}/purge_cache`;

/** A purge request's body, as the API takes it. */
type Body = { tags?: string[]; prefixes?: string[]; files?: string[] };
type Sent = { url: string; method?: string; headers: Headers; body: Body };

/** A stub `fetch` that records each request and answers with `reply()`, accepted by default. */
function stubFetch(reply: () => Response | Promise<Response> = ok) {
  const sent: Sent[] = [];
  const fetch = async (url: string, init: RequestInit) => {
    // SAFETY: purgeWorkCaches sends one purge body as a JSON string.
    const body = JSON.parse(init.body as string) as Body;
    sent.push({ url, method: init.method, headers: new Headers(init.headers), body });
    return reply();
  };
  return { sent, fetch };
}

function ok() {
  return Response.json({ success: true, errors: [], messages: [], result: { id: "x" } });
}

describe("purgeWorkCaches", () => {
  it("Asks Cloudflare to purge the work's tag, its images prefix and its download URLs", async () => {
    const { sent, fetch } = stubFetch();
    await purgeWorkCaches(credentials, { ao3WorkId: 12, uploadIds: ["up-1", "up-2"] }, { fetch });
    expect(sent.map((s) => s.body)).toEqual([
      { tags: ["work-12"] },
      { prefixes: ["content.rarepair.fans/works/12/img/"] },
      {
        files: [
          "https://content.rarepair.fans/originals/up-1.epub",
          "https://content.rarepair.fans/originals/up-1",
          "https://content.rarepair.fans/originals/up-2.epub",
          "https://content.rarepair.fans/originals/up-2",
        ],
      },
    ]);
    for (const s of sent) {
      expect(s.url).toBe(PURGE_URL);
      expect(s.method).toBe("POST");
      expect(s.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
      expect(s.headers.get("content-type")).toBe("application/json");
    }
  });

  it("Sends download URLs 100 a request at most, and none when there are no uploads", async () => {
    const uploadIds = Array.from({ length: 120 }, (_, i) => `up-${i}`);
    const many = stubFetch();
    await purgeWorkCaches(credentials, { ao3WorkId: 12, uploadIds }, { fetch: many.fetch });
    const files = many.sent.flatMap((s) => s.body.files ?? []);
    const sizes = many.sent.flatMap((s) => (s.body.files ? [s.body.files.length] : []));
    expect(sizes).toEqual([100, 100, 40]);
    expect(new Set(files).size).toBe(240);
    expect(files).toContain("https://content.rarepair.fans/originals/up-119.epub");
    expect(files).toContain("https://content.rarepair.fans/originals/up-119");

    const none = stubFetch();
    await purgeWorkCaches(credentials, { ao3WorkId: 12, uploadIds: [] }, { fetch: none.fetch });
    expect(none.sent.map((s) => s.body)).toEqual([
      { tags: ["work-12"] },
      { prefixes: ["content.rarepair.fans/works/12/img/"] },
    ]);
  });

  it("Fails when any request fails, after sending every one", async () => {
    const target = { ao3WorkId: 12, uploadIds: ["up-1"] };
    /** Answers the tag request with `failure`, the others as accepted. */
    const failTags = (failure: (init: RequestInit) => Promise<Response>) => {
      const stub = stubFetch();
      const fetch = (url: string, init: RequestInit) =>
        // SAFETY: purgeWorkCaches sends a JSON string body.
        (init.body as string).includes('"tags"')
          ? (stub.fetch(url, init), failure(init))
          : stub.fetch(url, init);
      return { sent: stub.sent, fetch };
    };
    const failures: [string, (init: RequestInit) => Promise<Response>][] = [
      ["a 5xx", async () => new Response("down", { status: 503 })],
      [
        "a 4xx",
        async () => Response.json({ success: false, errors: [{ code: 10000 }] }, { status: 403 }),
      ],
      [
        "success false on a 200",
        async () => Response.json({ success: false, errors: [{ code: 1134 }] }),
      ],
      ["a reply that isn't JSON", async () => new Response("<html>")],
      [
        "a network error",
        async () => {
          throw new TypeError("network");
        },
      ],
      [
        "no answer in time",
        (init) =>
          new Promise((_, reject) =>
            init.signal?.addEventListener("abort", () => reject(init.signal?.reason)),
          ),
      ],
    ];
    for (const [what, failure] of failures) {
      const { sent, fetch } = failTags(failure);
      const failed = purgeWorkCaches(credentials, target, { fetch, timeoutMs: 20 });
      await expect(failed, what).rejects.toThrow(/tags/);
      // The images and downloads were still asked for.
      expect(sent, what).toHaveLength(3);
    }
  });

  it("Refuses a missing token or zone, or wrangler.jsonc's placeholder zone, and sends nothing", async () => {
    const refused: [string, { token: string; zoneId: string }][] = [
      ["no token", { token: "", zoneId: ZONE }],
      // SAFETY: an unset secret is missing from the Worker's env, whatever Bindings says.
      ["an unset token", { zoneId: ZONE } as PurgeCredentials],
      // SAFETY: as above, for the zone.
      ["an unset zone", { token: TOKEN } as PurgeCredentials],
      ["no zone", { token: TOKEN, zoneId: "" }],
      ["the placeholder zone", { token: TOKEN, zoneId: "00000000000000000000000000000000" }],
      ["a zone that isn't one", { token: TOKEN, zoneId: "../../accounts/x" }],
    ];
    for (const [what, given] of refused) {
      const { sent, fetch } = stubFetch();
      await expect(
        purgeWorkCaches(given, { ao3WorkId: 12, uploadIds: [] }, { fetch }),
        what,
      ).rejects.toThrow(PurgeError);
      expect(sent, what).toEqual([]);
    }
  });

  it("Never names the token or the zone in its error", async () => {
    const { fetch } = stubFetch(() =>
      Response.json({
        success: false,
        errors: [{ code: 1134, message: `zone ${ZONE} token ${TOKEN}` }],
      }),
    );
    const failed = purgeWorkCaches(credentials, { ao3WorkId: 12, uploadIds: ["up-1"] }, { fetch });
    await expect(failed).rejects.toThrow(PurgeError);
    await expect(failed).rejects.toThrow(/1134/);
    await expect(failed).rejects.toMatchObject({ message: expect.not.stringContaining(TOKEN) });
    await expect(failed).rejects.toMatchObject({ message: expect.not.stringContaining(ZONE) });
  });
});
