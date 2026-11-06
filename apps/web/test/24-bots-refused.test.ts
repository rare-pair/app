import { createDb } from "@archive/db";
import { putFragments, seedWork } from "@archive/db/seed";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { chapterPageKey } from "../src/edge-cache";
import app from "../src/index";
import { LOGO_PATH } from "../src/logo";
import { STYLESHEET_PATH } from "../src/styles";
import {
  BASE,
  consoleDuring,
  fetchW,
  mailedWaitlistAddress,
  signIn,
  STRICT,
  withoutNonce,
} from "./helpers";

// Runs in the "open" project; 24-bots-refused.prelaunch.test.ts has the cases with PRELAUNCH on.
// This file keeps to AO3 work IDs 8812400 to 8812419. Text is synthetic.
const W = 8812400;
const H = 8812401;
const R = 8812402;
const NO_WORK = 8812403;
const CACHED = 8812404;
const TITLE = "BW-TITLE-MARKER";
const TEXT = "BW-CHAPTER-MARKER";

const CRAWLER = "Mozilla/5.0 (compatible; GPTBot/1.3; +https://openai.com/gptbot)";
const BROWSER =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36";

/** One of each kind of declared automated client. */
const DECLARED = {
  "search engine": { "user-agent": "Mozilla/5.0 (compatible; Googlebot/2.1)" },
  "link preview": { "user-agent": "facebookexternalhit/1.1" },
  "AI crawler": { "user-agent": CRAWLER },
  "HTTP library": { "user-agent": "python-requests/2.32.3" },
  signature: { "user-agent": BROWSER, "signature-agent": '"https://agent.example"' },
  "signature, empty": { "user-agent": BROWSER, "signature-agent": "" },
};

const REFUSAL = "Automated access to this site isn't allowed";

const db = createDb({ connectionString: env.HYPERDRIVE.connectionString, max: 1 });
afterAll(() => db.destroy());

const seed = async (ao3WorkId: number, extra: Parameters<typeof seedWork>[1] = {}) => {
  const work = await seedWork(db, {
    ao3WorkId,
    title: TITLE,
    summary: `<p>${TITLE}</p>`,
    chapters: [{ html: `<p>${TEXT}</p>` }, { html: `<p>${TEXT}</p>` }],
    tags: [{ type: "fandom", name: "bw-fandom" }],
    ...extra,
  });
  await putFragments(env.BUCKET, work.fragments);
};

beforeAll(async () => {
  await seed(W);
  await seed(H, { status: "hidden", hiddenCause: "moderator" });
  await seed(R, { status: "removed" });
  await seed(CACHED);
});

/** Asserts `res` is the refusal, and returns its body. */
async function expectRefusal(res: Response, label: string) {
  expect(res.status, label).toBe(403);
  expect(res.headers.get("cache-control"), label).toBe("no-store");
  expect(withoutNonce(res.headers.get("content-security-policy")), label).toBe(STRICT);
  expect(res.headers.get("strict-transport-security"), label).toBe(
    "max-age=31536000; includeSubDomains",
  );
  expect(res.headers.get("x-robots-tag"), label).toBe("noindex, noarchive, noai, noimageai");
  expect(res.headers.get("set-cookie"), label).toBeNull();
  const html = await res.text();
  if (res.headers.get("content-type")?.startsWith("text/html") && html !== "") {
    expect(html, label).toContain(REFUSAL);
    expect(html, label).not.toContain(TITLE);
    expect(html, label).not.toContain(TEXT);
  }
  return html;
}

const crawler = { headers: { "user-agent": CRAWLER } };

/** W's first chapter, asked for with `userAgent`. */
const chapterAs = (userAgent: string) =>
  fetchW(`/works/${W}/chapters/1`, { headers: { "user-agent": userAgent } });

/** A request handed to the app itself, so the test's console spies and bindings reach it. */
async function direct(path: string, init: RequestInit = {}, bindings: Partial<typeof env> = {}) {
  const ctx = createExecutionContext();
  const res = await app.fetch(new Request(new URL(path, BASE), init), { ...env, ...bindings }, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

const unsubscribe = (token: string) => ({
  path: `/waitlist/unsubscribe?token=${token}`,
  init: {
    method: "POST",
    headers: {
      ...DECLARED.signature,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: "List-Unsubscribe=One-Click",
  },
});

describe("24-crawler-and-agent-blocking", () => {
  it("Declared automated clients are refused the whole app", async () => {
    const paths = [
      `/works/${W}/chapters/1`,
      `/works/${W}/chapters`,
      `/works/${W}/full`,
      `/works/${W}`,
      "/tags/fandom/bw-fandom",
      "/search?q=bw",
      "/",
      "/about",
      "/login",
      "/no/such/page",
      STYLESHEET_PATH,
      LOGO_PATH,
    ];
    for (const [kind, headers] of Object.entries(DECLARED)) {
      for (const path of paths) {
        await expectRefusal(await fetchW(path, { headers }), `${kind} ${path}`);
      }
    }
  });

  it("Declared automated clients are refused the whole app: by any method", async () => {
    const headers = { "user-agent": CRAWLER, origin: BASE, "sec-fetch-site": "same-origin" };
    for (const method of ["GET", "HEAD", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"]) {
      for (const path of [`/works/${W}/chapters/1`, "/login", STYLESHEET_PATH]) {
        await expectRefusal(await fetchW(path, { method, headers }), `${method} ${path}`);
      }
    }
    // The upload routes, whose own same-origin guards come after the refusal.
    for (const [method, path] of [
      ["POST", "/uploads"],
      ["PUT", "/uploads/bw-upload"],
      ["DELETE", "/uploads/bw-upload"],
      ["POST", "/uploads/bw-upload/complete"],
      ["GET", "/uploads/bw-upload"],
    ] as const) {
      await expectRefusal(await fetchW(path, { method, headers }), `${method} ${path}`);
    }
  });

  it("Encoded paths are refused too", async () => {
    for (const path of [
      `/works/${W}/%66ull`,
      `/works/%38812400/full`,
      `/works/${W}/%63hapters/1`,
      `/works/${W}/chapters/%31`,
    ]) {
      await expectRefusal(await fetchW(path, crawler), path);
    }
  });

  it("A word inside a browser's user agent is not a match", async () => {
    const res = await fetchW(`/works/${W}/chapters/1`, {
      headers: {
        "user-agent":
          "Mozilla/5.0 (Linux; Android 14; Aabotz X1) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Mobile Safari/537.36",
      },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(TEXT);
  });

  it("The crawler list ignores case", async () => {
    for (const userAgent of ["GPTBOT/1.3", "gptbot/1.3", "GpTbOt/1.3"]) {
      const res = await chapterAs(userAgent);
      await expectRefusal(res, userAgent);
    }
  });

  it("A session does not exempt a declared automated client", async () => {
    const email = `bw-session-${crypto.randomUUID().slice(0, 8)}@example.test`;
    const cookie = await signIn(email, { acceptTerms: true });
    const path = `/works/${W}/chapters/1`;
    const signedIn = await fetchW(path, { headers: { cookie, "user-agent": CRAWLER } });
    const withoutSession = await fetchW(path, crawler);
    expect(await expectRefusal(signedIn, "session")).toBe(
      await expectRefusal(withoutSession, "no session"),
    );
    expect((await fetchW(path, { headers: { cookie, "user-agent": BROWSER } })).status).toBe(200);
  });

  it("The refusal comes before the edge cache", async () => {
    const url = `/works/${CACHED}/chapters/1`;
    const page = await (await fetchW(url)).text();
    expect(page).toContain(TEXT);
    await vi.waitFor(async () =>
      expect(await caches.default.match(chapterPageKey(CACHED, 1))).toBeDefined(),
    );
    await expectRefusal(await fetchW(url, crawler), "chapter");

    // The kept page is unchanged: a rename since doesn't show in what a later reader gets.
    await db
      .updateTable("works")
      .set({ title: "BW renamed" })
      .where("ao3_work_id", "=", CACHED)
      .execute();
    const later = await (await fetchW(url)).text();
    expect(later).toContain(TITLE);
    expect(later).not.toContain("BW renamed");
  });

  it("A refused request costs no lookups", async () => {
    const email = `bw-lookups-${crypto.randomUUID().slice(0, 8)}@example.test`;
    const cookie = await signIn(email, { acceptTerms: true });
    // A database that refuses every connection and a bucket that throws on any use: with either
    // touched, the request ends in the 500, as the reader's request below shows it does.
    const refused = { connectionString: "postgresql://nobody:none@127.0.0.1:1/none" };
    const noBucket = new Proxy(
      {},
      {
        get() {
          throw new Error("R2 was read");
        },
      },
    );
    const broken = {
      // SAFETY: only connectionString is read from a Hyperdrive binding.
      HYPERDRIVE: refused as Hyperdrive,
      // SAFETY: only connectionString is read from a Hyperdrive binding.
      HYPERDRIVE_CACHED: refused as Hyperdrive,
      // SAFETY: the Proxy throws on every property, which is the point.
      BUCKET: noBucket as R2Bucket,
    };
    const path = `/works/${W}/chapters/2`;
    let reader = 0;
    let refusal = 0;
    await consoleDuring(async () => {
      const init = (userAgent: string) => ({ headers: { cookie, "user-agent": userAgent } });
      reader = (await direct(path, init(BROWSER), broken)).status;
      refusal = (await direct(path, init(CRAWLER), broken)).status;
    });
    expect(reader).toBe(500);
    expect(refusal).toBe(403);
  });

  it("The refusal does not reveal a work's status", async () => {
    const live = await expectRefusal(await fetchW(`/works/${W}`, crawler), "live");
    for (const id of [W, H, R, NO_WORK]) {
      for (const path of [`/works/${id}`, `/works/${id}/chapters/1`, `/works/${id}/full`]) {
        const html = await expectRefusal(await fetchW(path, crawler), path);
        expect(html, path).toBe(live);
      }
    }
  });

  it("Link previews get nothing", async () => {
    const headers = { "user-agent": "Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)" };
    for (const path of [`/works/${W}`, `/works/${W}/chapters/1`, "/"]) {
      const html = await expectRefusal(await fetchW(path, { headers }), path);
      expect(html, path).not.toContain('property="og:');
    }
    // The card stays in the HTML for a client that isn't refused.
    expect(await (await fetchW(`/works/${W}`)).text()).toContain('property="og:title"');
  });

  it("Assistive and in-browser tools keep working", async () => {
    // Nothing is added to the request by a screen reader, translation, an extension or print, so
    // the browser's own user agent is what matters. The journeys in apps/web/browser show the rest.
    for (const userAgent of [
      BROWSER,
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/142.0.0.0 Safari/537.36",
    ]) {
      const res = await chapterAs(userAgent);
      expect(res.status, userAgent).toBe(200);
      expect(await res.text()).toContain(TEXT);
    }
  });

  it("Server-side tools that identify themselves are refused", async () => {
    for (const userAgent of [
      "Instapaper/8.0",
      "Mozilla/5.0 (compatible; Readwise/1.0)",
      "Mozilla/5.0 Chrome/142.0.0.0 Safari/537.36,gzip(gfe) (via translate.google.com)",
    ]) {
      const res = await chapterAs(userAgent);
      await expectRefusal(res, userAgent);
    }
  });

  it("Refusal page explains itself", async () => {
    const html = await expectRefusal(await fetchW("/", crawler), "home");
    expect(html).toContain("try another browser or turn off the tool that changed yours");
    expect(html).toContain('<a href="/">');
    expect(html).toContain('<a href="/about">');
  });

  it("Exempt paths are still served: robots.txt", async () => {
    for (const path of ["/robots.txt", "/%72obots.txt"]) {
      for (const method of ["GET", "HEAD"]) {
        const res = await fetchW(path, { method, headers: DECLARED.signature });
        expect(res.status, `${method} ${path}`).toBe(200);
        expect(res.headers.get("content-type"), path).toMatch(/^text\/plain/);
      }
    }
    await expectRefusal(await fetchW("/robots.txt/", crawler), "a slash after");
    await expectRefusal(await fetchW("/robots.txt", { method: "POST", ...crawler }), "POST");
  });

  it("Exempt paths are still served: POST /waitlist/unsubscribe", async () => {
    const { token, rows } = await mailedWaitlistAddress(db);
    const { path, init } = unsubscribe(token);
    expect(await rows()).toBe(1);
    await expectRefusal(await fetchW(path, { headers: DECLARED.signature }), "GET");
    expect(await rows()).toBe(1);
    await expectRefusal(await fetchW(path, { ...init, method: "PUT" }), "PUT");
    await expectRefusal(
      await fetchW(path.replace("unsubscribe", "unsubscribe/"), init),
      "a slash after",
    );
    expect(await rows()).toBe(1);

    const res = await fetchW(path, init);
    expect(res.status).toBe(200);
    expect(await res.text()).not.toContain(REFUSAL);
    expect(await rows()).toBe(0);
  });

  it("Exempt paths are still served: in the form the router matches", async () => {
    const { token, rows } = await mailedWaitlistAddress(db);
    const { path, init } = unsubscribe(token);
    const res = await fetchW(path.replace("/unsubscribe", "/%75nsubscribe"), init);
    expect(res.status).toBe(200);
    expect(await rows()).toBe(0);
  });

  describe("Another site can't spend a reader's limits", () => {
    const FIC_TEXT = [
      `/works/${W}/chapters`,
      `/works/${W}/chapters/1`,
      `/works/${W}/full`,
      `/works/${W}/%66ull`,
      `/works/%38812400/full`,
      `/works/${W}/%63hapters/1`,
      `/works/${W}/chapters/%31`,
      `/works/${H}/chapters/1`,
      `/works/${R}/chapters/1`,
      `/works/${NO_WORK}/full`,
    ];
    const embed = (dest: string, site = "cross-site") => ({
      headers: { "user-agent": BROWSER, "sec-fetch-site": site, "sec-fetch-dest": dest },
    });

    it("what another site embeds gets the 403", async () => {
      for (const dest of ["image", "iframe", "script", "empty"]) {
        for (const path of FIC_TEXT) {
          await expectRefusal(await fetchW(path, embed(dest)), `${dest} ${path}`);
        }
      }
    });

    it("a link from another site that the reader follows is served", async () => {
      const res = await fetchW(`/works/${W}/chapters/1`, embed("document"));
      expect(res.status).toBe(200);
      expect(await res.text()).toContain(TEXT);
      expect((await fetchW(`/works/${W}/full`, embed("document"))).status).toBe(200);
    });

    it("this site's own requests are served", async () => {
      for (const site of ["same-origin", "same-site", "none"]) {
        expect((await fetchW(`/works/${W}/full`, embed("empty", site))).status, site).toBe(200);
      }
      expect((await fetchW(`/works/${W}/full`)).status).toBe(200);
    });

    it("only fic text paths have the check", async () => {
      for (const path of [`/works/${W}`, "/about", "/", STYLESHEET_PATH]) {
        expect((await fetchW(path, embed("image"))).status, path).toBe(200);
      }
    });
  });

  it("Refusals are counted by reason", async () => {
    const CLIENT_IP = "198.51.100.77";
    const secret = '"https://agent-marker.example"';
    const path = `/works/${W}/chapters/1?marker=bw-query`;
    const logged = (headers: Record<string, string>) =>
      consoleDuring(async () => {
        await direct(path, { headers: { "cf-connecting-ip": CLIENT_IP, ...headers } });
      });
    // Exactly this one line each: inspect, in consoleDuring, quotes a string.
    expect(await logged({ "signature-agent": secret })).toEqual(["'refused: signature'"]);
    expect(await logged({ "user-agent": CRAWLER })).toEqual(["'refused: crawler list'"]);
    expect(await logged({ "sec-fetch-site": "cross-site", "sec-fetch-dest": "image" })).toEqual([
      "'refused: cross-site subresource'",
    ]);
  });

  it("Refusals are counted by reason: nothing is logged for what isn't refused", async () => {
    const { token } = await mailedWaitlistAddress(db);
    const { path, init } = unsubscribe(token);
    const lines = await consoleDuring(async () => {
      await direct(path, init);
      await direct("/robots.txt", crawler);
      await direct(`/works/${W}/chapters/1`);
    });
    expect(lines.filter((line) => line.includes("refused"))).toEqual([]);
  });
});
