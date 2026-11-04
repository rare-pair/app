import { createDb } from "@archive/db";
import { putFragments, seedWork } from "@archive/db/seed";
import { env } from "cloudflare:workers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fetchW, nonceOf, signIn } from "./helpers";

// Every work here has an AO3 work ID in 24001-24099, so no other test file sharing the
// database sees them. The browser side of the position script (the scroll, the debounce)
// has no DOM runner here: what is tested is what the Worker serves and stores.
const W = 24001;
const GONE = 24002;

const db = createDb({ connectionString: env.HYPERDRIVE.connectionString, max: 1 });

beforeAll(async () => {
  const w = await seedWork(db, {
    ao3WorkId: W,
    title: "R6 work",
    // Synthetic markers only: no fic text in tests.
    chapters: [{ html: "<p>R6-ONE-TEXT</p>" }, { html: "<p>R6-TWO-TEXT</p>" }],
  });
  await putFragments(env.BUCKET, w.fragments);
});

afterAll(() => db.destroy());

const CHAPTER = `/works/${W}/chapters/2`;
const FULL = `/works/${W}/full`;
const WORK = `/works/${W}`;
const SAVE = `/works/${W}/position`;

/** The headers a browser on rarepair.fans sends with the script's fetch. */
const SAME_SITE = {
  "content-type": "application/x-www-form-urlencoded",
  origin: "https://rarepair.fans",
  "sec-fetch-site": "same-origin",
};

const save = (cookie: string | null, body: string, headers: Record<string, string> = SAME_SITE) => {
  const sent = new Headers(headers);
  if (cookie !== null) sent.set("cookie", cookie);
  return fetchW(SAVE, { method: "POST", headers: sent, body });
};

/** Every stored position's value, whoever's, in key order. */
const stored = async () => {
  const { keys } = await env.POSITIONS.list({ prefix: "pos:" });
  return Promise.all(keys.map(async (k) => [k.name, await env.POSITIONS.get(k.name)] as const));
};

const asReader = (cookie: string) => ({ headers: { cookie } });
const SCRIPT_TAG = /<script src="(\/assets\/reading-position\.[0-9a-f]+\.js)" nonce="([^"]+)"/;

describe("13-reader-settings-and-position: Reading position saved for signed-in readers with JS", () => {
  it("A signed-in chapter page carries the position script with the page's nonce", async () => {
    const cookie = await signIn("r6-chapter@example.invalid", { acceptTerms: true });
    const res = await fetchW(CHAPTER, asReader(cookie));
    expect(res.status).toBe(200);
    const [, src, nonce] = SCRIPT_TAG.exec(await res.text()) ?? [];
    expect(src).toBeDefined();
    expect(nonce).toBe(nonceOf(res.headers.get("content-security-policy")));
  });

  it("The script is served as an immutable, nosniff script file", async () => {
    const cookie = await signIn("r6-script@example.invalid", { acceptTerms: true });
    const src = SCRIPT_TAG.exec(await (await fetchW(CHAPTER, asReader(cookie))).text())?.[1];
    const res = await fetchW(src ?? "/missing.js");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  it("A signed-in reader's chapter and percentage are stored under their own key", async () => {
    const cookie = await signIn("r6-save@example.invalid", { acceptTerms: true });
    const res = await save(cookie, "n=2&pct=40");
    expect(res.status).toBe(204);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const mine = (await stored()).filter(([key]) => key.endsWith(`:${W}`));
    expect(mine.map(([, value]) => JSON.parse(value ?? "null"))).toContainEqual({ n: 2, pct: 40 });
    expect(mine.every(([key]) => /^pos:[^:]+:24001$/.test(key))).toBe(true);
  });

  it("A stored position expires after a year", async () => {
    const cookie = await signIn("r6-ttl@example.invalid", { acceptTerms: true });
    expect((await save(cookie, "n=1&pct=5")).status).toBe(204);
    const { keys } = await env.POSITIONS.list({ prefix: "pos:" });
    const year = Date.now() / 1000 + 365 * 24 * 60 * 60;
    const expires = keys.filter((k) => k.name.endsWith(`:${W}`)).map((k) => k.expiration ?? 0);
    expect(expires.length).toBeGreaterThan(0);
    for (const at of expires) expect(Math.abs(at - year)).toBeLessThan(600);
  });
});

describe("13-reader-settings-and-position: Entire work view saves position", () => {
  it("A signed-in entire-work page carries the position script, async, with the page's nonce", async () => {
    const cookie = await signIn("r6-full@example.invalid", { acceptTerms: true });
    const res = await fetchW(FULL, asReader(cookie));
    expect(res.status).toBe(200);
    const html = await res.text();
    const [, , nonce] = SCRIPT_TAG.exec(html) ?? [];
    expect(nonce).toBe(nonceOf(res.headers.get("content-security-policy")));
    expect(html).toMatch(/reading-position\.[0-9a-f]+\.js" nonce="[^"]+" async><\/script>/);
  });

  it("A position with no chapter, as the entire-work page posts it, is stored", async () => {
    const cookie = await signIn("r6-full-save@example.invalid", { acceptTerms: true });
    expect((await save(cookie, "pct=75")).status).toBe(204);
    const values = (await stored()).map(([, value]) => JSON.parse(value ?? "null"));
    expect(values).toContainEqual({ n: null, pct: 75 });
  });
});

describe("13-reader-settings-and-position: No position saved for signed-out readers", () => {
  it("The reading pages carry no position script for a signed-out reader", async () => {
    for (const path of [CHAPTER, FULL]) {
      const html = await (await fetchW(path)).text();
      expect(html, path).toContain("<article");
      expect(html, path).not.toContain("reading-position");
    }
  });

  it("A signed-out save is refused with 401 and writes nothing", async () => {
    const before = await stored();
    const res = await save(null, "n=1&pct=10");
    expect(res.status).toBe(401);
    expect(res.headers.get("location")).toBeNull();
    expect(await stored()).toEqual(before);
  });

  it("A save from an account that has not accepted the terms gets 401, not a redirect, and writes nothing", async () => {
    const cookie = await signIn("r6-terms@example.invalid");
    const before = await stored();
    const res = await save(cookie, "n=1&pct=10");
    expect(res.status).toBe(401);
    expect(res.headers.get("location")).toBeNull();
    expect(await stored()).toEqual(before);
  });

  it("A save from another site is refused with 403 and writes nothing", async () => {
    const cookie = await signIn("r6-cross@example.invalid", { acceptTerms: true });
    const before = await stored();
    for (const headers of [
      { ...SAME_SITE, origin: "https://evil.example" },
      { ...SAME_SITE, "sec-fetch-site": "cross-site" },
      { "content-type": SAME_SITE["content-type"] },
    ]) {
      expect((await save(cookie, "n=1&pct=10", headers)).status).toBe(403);
    }
    expect(await stored()).toEqual(before);
  });

  it("A malformed or out-of-range save is refused with 400 and writes nothing", async () => {
    const cookie = await signIn("r6-bad@example.invalid", { acceptTerms: true });
    const before = await stored();
    for (const body of [
      "",
      "n=1",
      "pct=101",
      "pct=-1",
      "pct=1.5",
      "pct=abc",
      "pct=05",
      "n=0&pct=1",
      "n=x&pct=1",
      "n=007&pct=1",
      "n=2147483648&pct=1",
    ]) {
      expect((await save(cookie, body)).status, body).toBe(400);
    }
    expect(
      (await save(cookie, "pct=1", { ...SAME_SITE, "content-type": "text/plain" })).status,
    ).toBe(400);
    expect(await stored()).toEqual(before);
  });

  it("A save for a work ID that is not a number is a 404", async () => {
    const cookie = await signIn("r6-id@example.invalid", { acceptTerms: true });
    const res = await fetchW("/works/007/position", {
      method: "POST",
      headers: { ...SAME_SITE, cookie },
      body: "pct=1",
    });
    expect(res.status).toBe(404);
  });

  it("A page that is not a 200 reading page carries no position script, even signed in", async () => {
    const cookie = await signIn("r6-refused@example.invalid", { acceptTerms: true });
    for (const path of [
      `/works/${GONE}/chapters/1`,
      `/works/${GONE}/full`,
      `/works/${W}/chapters/9`,
    ]) {
      const res = await fetchW(path, asReader(cookie));
      expect(res.status, path).toBe(404);
      expect(await res.text(), path).not.toContain("reading-position");
    }
  });
});

describe("13-reader-settings-and-position: Returning reader is offered their place", () => {
  it("The work page offers the saved chapter and percentage, and does not move the reader", async () => {
    const cookie = await signIn("r6-return@example.invalid", { acceptTerms: true });
    expect((await save(cookie, "n=2&pct=40")).status).toBe(204);
    const res = await fetchW(WORK, asReader(cookie));
    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    const html = await res.text();
    expect(html).toContain(
      `<a href="/works/${W}/chapters/2#pos=40">Continue where you left off</a>`,
    );
    expect(html).not.toMatch(/http-equiv="refresh"/i);
    expect(html).not.toContain("<script");
  });
});

describe("10-work-page: Continue where you left off for signed-in readers", () => {
  it("A reader whose last page was the entire work is offered that page", async () => {
    const cookie = await signIn("r6-continue-full@example.invalid", { acceptTerms: true });
    expect((await save(cookie, "pct=75")).status).toBe(204);
    const html = await (await fetchW(WORK, asReader(cookie))).text();
    expect(html).toContain(`<a href="/works/${W}/full#pos=75">Continue where you left off</a>`);
  });

  it("A saved chapter the current version no longer has shows no link", async () => {
    const cookie = await signIn("r6-continue-gone@example.invalid", { acceptTerms: true });
    expect((await save(cookie, "n=9&pct=50")).status).toBe(204);
    expect(await (await fetchW(WORK, asReader(cookie))).text()).not.toContain("Continue where");
  });
});

describe("10-work-page: No continue link without a saved position", () => {
  it("A signed-out reader sees no link", async () => {
    expect(await (await fetchW(WORK)).text()).not.toContain("Continue where");
  });

  it("A signed-in reader with no saved position sees no link, whatever others saved", async () => {
    const saver = await signIn("r6-nolink-saver@example.invalid", { acceptTerms: true });
    expect((await save(saver, "n=1&pct=10")).status).toBe(204);
    const other = await signIn("r6-nolink-other@example.invalid", { acceptTerms: true });
    const res = await fetchW(WORK, asReader(other));
    expect(res.status).toBe(200);
    expect(await res.text()).not.toContain("Continue where");
  });

  it("A saved place in another work is not offered on this one", async () => {
    const cookie = await signIn("r6-nolink-work@example.invalid", { acceptTerms: true });
    const elsewhere = await fetchW(`/works/${GONE}/position`, {
      method: "POST",
      headers: { ...SAME_SITE, cookie },
      body: "n=1&pct=10",
    });
    expect(elsewhere.status).toBe(204);
    expect(await (await fetchW(WORK, asReader(cookie))).text()).not.toContain("Continue where");
  });
});
