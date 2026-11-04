import { createDb } from "@archive/db";
import { putFragments, seedWork } from "@archive/db/seed";
import { env } from "cloudflare:workers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { STRICT, fetchW, nonceOf, withoutNonce } from "./helpers";

// Every work here has an AO3 work ID in 12001-12099 and tags named r8-..., so no other
// test file sharing the database sees them.
const M = 12001; // Mature
const E = 12002; // Explicit
const V = 12003; // Teen, with a warning
const C = 12004; // Teen, creator chose not to use warnings
const G = 12005; // General, no warnings
const N = 12006; // no rating
const H = 12007; // Mature and hidden

const NO_WARNINGS = { type: "warning" as const, name: "No Archive Warnings Apply" };
const rated = (name: string) => ({ type: "rating" as const, name });

const db = createDb({ connectionString: env.HYPERDRIVE.connectionString, max: 1 });

beforeAll(async () => {
  const works = [
    { ao3WorkId: M, rating: "Mature", tags: [rated("Mature"), NO_WARNINGS] },
    { ao3WorkId: E, rating: "Explicit", tags: [rated("Explicit"), NO_WARNINGS] },
    {
      ao3WorkId: V,
      rating: "Teen And Up Audiences",
      tags: [{ type: "warning" as const, name: "Graphic Depictions Of Violence" }],
    },
    {
      ao3WorkId: C,
      rating: "Teen And Up Audiences",
      tags: [{ type: "warning" as const, name: "Creator Chose Not To Use Archive Warnings" }],
    },
    { ao3WorkId: G, rating: "General Audiences", tags: [NO_WARNINGS] },
    { ao3WorkId: N, rating: null, tags: [NO_WARNINGS], reviewReasons: ["missing_rating"] },
    {
      ao3WorkId: H,
      rating: "Mature",
      tags: [NO_WARNINGS],
      status: "hidden" as const,
      hiddenCause: "moderator" as const,
    },
  ];
  for (const options of works) {
    const w = await seedWork(db, {
      ...options,
      title: `R8 work ${options.ao3WorkId}`,
      // Synthetic markers only: no fic text in tests.
      chapters: Array.from({ length: 5 }, (_, i) => ({
        html: `<p>R8-${options.ao3WorkId}-${i + 1}</p>`,
      })),
    });
    await putFragments(env.BUCKET, w.fragments);
  }
});

afterAll(() => db.destroy());

const chapter = (id: number, n: number) => `/works/${id}/chapters/${n}`;
const full = (id: number) => `/works/${id}/full`;
const warnings = (id: number, next: string) =>
  `/works/${id}/warnings?next=${encodeURIComponent(next)}`;

/** The name=value pair of a response's Set-Cookie, to send back as a Cookie header. */
const cookieOf = (response: Response) => response.headers.get("set-cookie")?.split(";")[0] ?? "";

/** Continues past a work's screen, as the screen's own form does, and returns the cookie. */
const continueFrom = async (id: number, next: string, cookie = "") => {
  const response = await fetchW(`/works/${id}/warnings`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin: "https://rarepair.fans",
      cookie,
    },
    body: new URLSearchParams({ next }).toString(),
  });
  return response;
};

describe("12-warnings-interstitial: the screen comes first", () => {
  it("Mature work shows the interstitial before chapter 1", async () => {
    const gate = await fetchW(chapter(M, 1));
    expect(gate.status).toBe(302);
    expect(gate.headers.get("location")).toBe(warnings(M, chapter(M, 1)));
    expect(gate.headers.get("cache-control")).toBe("private, no-store");
    const page = await fetchW(gate.headers.get("location") ?? "");
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Rating: Mature");
  });

  it("Explicit work shows the interstitial", async () => {
    const gate = await fetchW(chapter(E, 1));
    expect(gate.status).toBe(302);
    const page = await fetchW(gate.headers.get("location") ?? "");
    expect(await page.text()).toContain("Rating: Explicit");
  });

  it("Work with archive warnings shows the interstitial", async () => {
    const gate = await fetchW(chapter(V, 1));
    expect(gate.status).toBe(302);
    const page = await fetchW(gate.headers.get("location") ?? "");
    expect(await page.text()).toContain("Graphic Depictions Of Violence");
  });

  it("Choose Not To Use Archive Warnings shows the interstitial", async () => {
    const gate = await fetchW(chapter(C, 1));
    expect(gate.status).toBe(302);
    const page = await fetchW(gate.headers.get("location") ?? "");
    expect(await page.text()).toContain("Creator Chose Not To Use Archive Warnings");
  });

  it("Unrated work shows the interstitial as Not Rated", async () => {
    const gate = await fetchW(chapter(N, 1));
    expect(gate.status).toBe(302);
    const page = await fetchW(gate.headers.get("location") ?? "");
    expect(await page.text()).toContain("Rating: Not Rated");
    const go = await continueFrom(N, chapter(N, 1));
    expect(go.status).toBe(303);
    expect(go.headers.get("location")).toBe(chapter(N, 1));
  });

  it("Unwarned general work skips the interstitial", async () => {
    const response = await fetchW(chapter(G, 1));
    expect(response.status).toBe(200);
    expect(await response.text()).toContain(`R8-${G}-1`);
  });

  it("Direct link to a later chapter shows the interstitial first", async () => {
    const gate = await fetchW(chapter(M, 3));
    expect(gate.status).toBe(302);
    expect(gate.headers.get("location")).toBe(warnings(M, chapter(M, 3)));
    const go = await continueFrom(M, chapter(M, 3));
    expect(go.headers.get("location")).toBe(chapter(M, 3));
  });

  it("Entire work shows the interstitial first", async () => {
    const gate = await fetchW(full(V));
    expect(gate.status).toBe(302);
    expect(gate.headers.get("location")).toBe(warnings(V, full(V)));
    const go = await continueFrom(V, full(V));
    expect(go.headers.get("location")).toBe(full(V));
  });

  it("an unseen reader's HEAD gets the redirect too", async () => {
    expect((await fetchW(chapter(M, 1), { method: "HEAD" })).status).toBe(302);
    expect((await fetchW(full(M), { method: "HEAD" })).status).toBe(302);
  });

  it("a chapter that doesn't exist is a 404, not the screen", async () => {
    expect((await fetchW(chapter(M, 9))).status).toBe(404);
  });

  it("a hidden work is a 451, not the screen", async () => {
    expect((await fetchW(chapter(H, 1))).status).toBe(451);
    expect((await fetchW(full(H))).status).toBe(451);
    expect((await fetchW(`/works/${H}/warnings`)).status).toBe(451);
  });
});

describe("12-warnings-interstitial: continuing", () => {
  it("Continue goes to the chapter", async () => {
    const response = await continueFrom(M, chapter(M, 1));
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(chapter(M, 1));
    const opened = await fetchW(chapter(M, 1), { headers: { cookie: cookieOf(response) } });
    expect(opened.status).toBe(200);
  });

  it("Interstitial is remembered for the work in the session", async () => {
    const set = await continueFrom(M, chapter(M, 1));
    const header = set.headers.get("set-cookie") ?? "";
    expect(header).toMatch(/^__Host-warned=/);
    expect(header).toContain("Path=/");
    expect(header).toContain("Secure");
    expect(header).toContain("HttpOnly");
    expect(header).toContain("SameSite=Lax");
    expect(header).not.toMatch(/Max-Age|Expires|Domain/i);

    const cookie = cookieOf(set);
    const four = await fetchW(chapter(M, 4), { headers: { cookie } });
    expect(four.status).toBe(200);
    expect(await four.text()).toContain(`R8-${M}-4`);
    expect((await fetchW(full(M), { headers: { cookie } })).status).toBe(200);
    // Another work in the same session still shows its own screen.
    expect((await fetchW(chapter(E, 1), { headers: { cookie } })).status).toBe(302);
  });

  it("remembers a second work beside the first", async () => {
    const first = cookieOf(await continueFrom(M, chapter(M, 1)));
    const both = cookieOf(await continueFrom(E, chapter(E, 1), first));
    expect((await fetchW(chapter(M, 2), { headers: { cookie: both } })).status).toBe(200);
    expect((await fetchW(chapter(E, 2), { headers: { cookie: both } })).status).toBe(200);
  });

  it("Interstitial comes back in a new session", async () => {
    expect((await fetchW(chapter(M, 2))).status).toBe(302);
  });

  it("sends a tampered next to chapter 1", async () => {
    for (const next of ["/admin", "//evil.example/", "https://evil.example/", chapter(E, 1)]) {
      const response = await continueFrom(M, next);
      expect(response.headers.get("location")).toBe(chapter(M, 1));
    }
  });

  it("refuses a cross-site post", async () => {
    const response = await fetchW(`/works/${M}/warnings`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: "https://evil.example",
      },
      body: "next=",
    });
    expect(response.status).toBe(403);
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("a work that needs no screen goes straight to chapter 1", async () => {
    const response = await fetchW(`/works/${G}/warnings`);
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(chapter(G, 1));
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });
});

describe("12-warnings-interstitial: the page", () => {
  it("Warnings screen is a full page, not a modal", async () => {
    const response = await fetchW(`/works/${V}/warnings`);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("<main");
    expect(html).toContain("<h1>");
    expect(html).toContain(`<form method="post" action="/works/${V}/warnings">`);
    expect(html).toContain(">Continue</button>");
    expect(html).not.toMatch(/<dialog|aria-modal|role="dialog"|tabindex|autofocus/);
    // No script of its own: nothing runs, so nothing traps focus.
    const nonce = nonceOf(response.headers.get("content-security-policy"));
    expect(nonce).not.toBeNull();
    expect(withoutNonce(response.headers.get("content-security-policy"))).toBe(STRICT);
  });

  it("Warnings screen needs no focus trap", async () => {
    const html = await (await fetchW(`/works/${M}/warnings`)).text();
    expect(html).not.toMatch(/<dialog|aria-modal|role="dialog"|tabindex|autofocus/);
  });

  it("is never cached", async () => {
    const response = await fetchW(`/works/${V}/warnings`);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });
});
