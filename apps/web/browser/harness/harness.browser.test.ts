import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { presignPut } from "../../src/presign";
import { EPUB_TYPE } from "../../src/upload-limit";
import { SECRETS } from "../../test/stand-ins";
import type { CleanOptions } from "./clean";
import { useJourneySite } from "./journey";
import { R2_HOST, signedKey } from "./r2-put";
import { startRecorder, videoName } from "./recording";
import { signedIn } from "./sessions";
import { launchChromium, SITE, startSite, type Site } from "./site";

// The harness's own helpers: each must catch what it is there to catch, or a pass on a journey
// shows nothing.

const EPUB = EPUB_TYPE;
const presigned = (key: string, now = new Date(), expiresSeconds = 600) =>
  presignPut({
    accountId: SECRETS.R2_ACCOUNT_ID,
    bucket: "rarepair",
    accessKeyId: SECRETS.R2_ACCESS_KEY_ID,
    secretAccessKey: SECRETS.R2_SECRET_ACCESS_KEY,
    key,
    contentType: EPUB,
    expiresSeconds,
    now,
  });

describe("on a running site", () => {
  let site: Site;
  beforeAll(async () => {
    site = await startSite();
  });
  afterAll(() => site.close());

  /** What `assertClean` says, polled: Chromium reports console messages when it gets to them. */
  const complaint = (options?: CleanOptions) =>
    expect.poll(() =>
      site
        .assertClean(options)
        .then(() => "")
        .catch(String),
    );

  const realPage = async () => {
    const context = await site.newContext();
    const page = await context.newPage();
    await page.goto(SITE);
    return page;
  };

  describe("assertClean", () => {
    it("fails on a CSP violation, then forgets it", async () => {
      const page = await realPage();
      await site.assertClean();
      await page.evaluate(() => {
        const img = document.createElement("img");
        img.src = "https://off-site.example/refused-by-csp.png";
        document.body.append(img);
      });
      await complaint().toContain("Content Security Policy");
      await expect(site.assertClean()).resolves.toBeUndefined();
    });

    it("fails on a console error", async () => {
      const page = await realPage();
      await page.evaluate(() => console.error("a synthetic console error"));
      await complaint().toContain("a synthetic console error");
    });

    it("fails on a script error", async () => {
      const page = await realPage();
      await page.evaluate(() => {
        setTimeout(() => {
          throw new Error("a synthetic script error");
        });
      });
      await complaint().toContain("a synthetic script error");
    });

    it("fails on an off-site request with no stand-in", async () => {
      const page = await (await site.newContext()).newPage();
      // A blank page has no CSP, so the request reaches the harness's own refusal.
      await page.goto("about:blank");
      await page.evaluate(() =>
        fetch("https://off-site.example/no-stand-in").catch(() => undefined),
      );
      await complaint().toContain("off-site request: https://off-site.example/no-stand-in");
    });

    it("excuses only what it is told to", async () => {
      const page = await realPage();
      await page.evaluate(() => {
        console.error("an expected error");
        console.error("an unexpected error");
      });
      const thrown = await site.assertClean({ allow: [/an expected error/] }).catch(String);
      expect(thrown).toContain("an unexpected error");
      expect(thrown).not.toContain("an expected error");
    });

    it("leaves the content host and Turnstile stand-in alone", async () => {
      // Seen as local or stood in, neither is off-site: the login page loads Turnstile.
      const page = await (await site.newContext()).newPage();
      await page.goto(`${SITE}/login`);
      await page.waitForFunction(() => "turnstile" in window);
      const res = await page.goto("https://content.rarepair.fans/originals/nothing-here");
      expect(res?.status()).toBe(404);
      // The 404 is the page's own status line, and nothing else.
      await site.assertClean({ allow: [/responded with a status of 404/] });
      expect(site.offSite).not.toContain("https://content.rarepair.fans/originals/nothing-here");
    });
  });

  describe("newContext", () => {
    it("with javaScript off, runs none of a page's scripts", async () => {
      const probe = async (javaScript?: boolean) => {
        const page = await (await site.newContext({ javaScript })).newPage();
        await page.goto(`${SITE}/login`);
        // The login page loads Turnstile's script, which stands in as `window.turnstile`.
        return page.evaluate(() => "turnstile" in window);
      };
      expect(await probe()).toBe(true);
      expect(await probe(false)).toBe(false);
      await site.assertClean();
    });
  });

  describe("the presigned PUT stand-in", () => {
    it("stores a PUT signed by the web Worker's method, and refuses a forged one", async () => {
      const { context } = await signedIn(site, { email: "pw0-put@example.test" });
      const page = await context.newPage();
      // The upload page's CSP is the one that lets a script reach the endpoint.
      await page.goto(`${SITE}/upload`);
      const put = (url: string) =>
        page.evaluate(
          async ([target, type]) =>
            (await fetch(target, { method: "PUT", headers: { "content-type": type }, body: "x" }))
              .status,
          [url, EPUB],
        );
      const good = await presigned("uploads/pw0-good");
      expect(await put(good)).toBe(200);
      expect(await site.bucket.head("uploads/pw0-good")).not.toBeNull();

      const forged = good.replace("uploads/pw0-good", "uploads/pw0-forged");
      expect(await put(forged)).toBe(403);
      expect(await site.bucket.head("uploads/pw0-forged")).toBeNull();
      await site.assertClean({ allow: [/status of 403/] });
    });
  });
});

describe("a journey", () => {
  const running = useJourneySite();
  let bodyFinished = false;

  // The check runs in useJourneySite's afterEach, with nothing in the test to fail it.
  it.fails("fails on a console error though the test itself passes", async () => {
    const page = await (await running.site.newContext()).newPage();
    await page.goto(SITE);
    await page.evaluate(() => console.error("a synthetic console error"));
    bodyFinished = true;
  });

  it("failed only in that check, and closed the context the test opened", () => {
    expect(bodyFinished).toBe(true);
    expect(running.site.contexts()).toEqual([]);
  });
});

describe("the presigned PUT stand-in's signature check", () => {
  const NOW = new Date("2026-11-04T04:00:00.000Z");
  const key = "uploads/pw0-key";

  it("names the key of a URL as presigned", async () => {
    expect(await signedKey(await presigned(key, NOW), EPUB, NOW)).toBe(key);
  });

  it("refuses a URL altered after signing", async () => {
    const url = (await presigned(key, NOW)).replace(key, "uploads/pw0-other");
    expect(await signedKey(url, EPUB, NOW)).toBeNull();
  });

  it("refuses another content type", async () => {
    expect(await signedKey(await presigned(key, NOW), "text/html", NOW)).toBeNull();
  });

  it("refuses a URL past its expiry", async () => {
    const late = new Date(NOW.getTime() + 601_000);
    expect(await signedKey(await presigned(key, NOW), EPUB, late)).toBeNull();
  });

  it("is on the host the Worker signs for", async () => {
    expect(new URL(await presigned(key, NOW)).host).toBe(R2_HOST);
  });
});

describe("recording", () => {
  it("names a file for its test, with a suffix for a repeat", () => {
    const taken = new Set<string>();
    const name = () => videoName("upload journey > Reads: a chapter!", taken);
    expect([name(), name()]).toEqual([
      "upload-journey-reads-a-chapter",
      "upload-journey-reads-a-chapter-2",
    ]);
    expect(videoName("x".repeat(300), taken)).toHaveLength(100);
    expect(videoName("!!!", taken)).toBe("test");
  });

  /** Runs `body` with `BROWSER_RECORD` as given, whatever the run itself set. */
  const withEnv = async (value: string | undefined, body: () => Promise<void>) => {
    const before = process.env.BROWSER_RECORD;
    if (value === undefined) delete process.env.BROWSER_RECORD;
    else process.env.BROWSER_RECORD = value;
    try {
      await body();
    } finally {
      if (before === undefined) delete process.env.BROWSER_RECORD;
      else process.env.BROWSER_RECORD = before;
    }
  };

  it("BROWSER_RECORD saves a WebM of the page named for the test", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pw0-record-"));
    try {
      await withEnv(dir, async () => {
        const site = await startSite();
        try {
          const { context } = await signedIn(site, { email: "pw0-record@example.test" });
          const page = await context.newPage();
          await page.goto(SITE);
        } finally {
          await site.close();
        }
      });
      const files = await readdir(dir);
      // The sign-in steps are the harness's, not the test's: only the one page is left.
      expect(files).toEqual([
        "recording-browser-record-saves-a-webm-of-the-page-named-for-the-test.webm",
      ]);
      const bytes = await readFile(join(dir, files[0]));
      // The EBML magic number every WebM starts with.
      expect(bytes.subarray(0, 4).toString("hex")).toBe("1a45dfa3");
      expect((await stat(join(dir, files[0]))).size).toBeLessThan(10 * 1024 * 1024);
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("with BROWSER_RECORD unset, nothing is recorded", async () => {
    await withEnv(undefined, async () => {
      const site = await startSite();
      try {
        const page = await (await site.newContext()).newPage();
        await page.goto(SITE);
        expect(page.video()).toBeNull();
      } finally {
        await site.close();
      }
    });
  });

  it("fails on a recording over the limit", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pw0-record-"));
    const browser = await launchChromium();
    try {
      const recorder = startRecorder(dir, 1);
      const context = await browser.newContext(recorder.contextOptions);
      recorder.watch(context);
      await context.newPage();
      await expect(recorder.finish()).rejects.toThrow(/over 1\b/);
    } finally {
      await browser.close();
      await rm(dir, { recursive: true });
    }
  });
});
