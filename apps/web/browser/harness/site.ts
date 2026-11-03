import { createDb, type Database } from "@archive/db";
import type { FragmentBucket } from "@archive/db/seed";
import { createTestDb } from "@archive/db/testing";
import type { Kysely } from "kysely";
import type { RequestInit, Response } from "miniflare";
import { chromium, type Browser, type BrowserContext } from "playwright";
import { parseMessage, type EmailMessage } from "../../../mailer/src/message";
import { startWorker } from "./worker";

/** Where the browser visits: the real site's origin, mapped to the local Worker. */
export const SITE = "https://rarepair.fans";
const HOST = new URL(SITE).host;
// Stood in for in the browser, never fetched: Turnstile's script, and the image host.
const TURNSTILE_SCRIPT = "https://challenges.cloudflare.com/turnstile/v0/api.js";
const CONTENT = "https://content.rarepair.fans/";
// A transparent 1x1 PNG, for every image on the content host.
const PIXEL = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);

export type Viewport = { width: number; height: number };

/** The window every suite uses unless it asks for another. */
export const DESKTOP: Viewport = { width: 1280, height: 800 };

/**
 * The viewport `BROWSER_VIEWPORT` names, as `<width>x<height>` ("360x640"), or `DESKTOP`
 * when it is unset. Throws on anything else, so a typo never runs the suite at the default.
 */
export function viewportFromEnv(value = process.env.BROWSER_VIEWPORT): Viewport {
  if (value === undefined || value === "") return DESKTOP;
  const match = /^(\d+)x(\d+)$/.exec(value);
  if (match === null) throw new Error(`BROWSER_VIEWPORT must look like 360x640, not "${value}"`);
  return { width: Number(match[1]), height: Number(match[2]) };
}

export type SiteOptions = {
  /** PRELAUNCH as wrangler.jsonc deploys it (true), or the archive open (false, the default). */
  prelaunch?: boolean;
  /** Default: `viewportFromEnv()`. */
  viewport?: Viewport;
};

export type ContextOptions = {
  /**
   * The client address the Worker sees (`cf-connecting-ip`), for its rate limits. Default: a
   * new one for each context, so contexts never share a limit.
   */
  ip?: string;
};

/** The running site: the Worker, its database and bucket, and a browser to visit it with. */
export type Site = {
  /** The database the Worker reads, for seeding. */
  db: Kysely<Database>;
  /** The Worker's R2 bucket, for seeding fragments. */
  bucket: FragmentBucket;
  viewport: Viewport;
  browser: Browser;
  /**
   * A new browser context on the site, with the stand-ins for third parties: Turnstile's
   * script is an empty one and every content-host image a 1x1 PNG. Any other request off
   * the site is refused and recorded in `offSite`.
   */
  newContext: (options?: ContextOptions) => Promise<BrowserContext>;
  /** Every off-site URL a page asked for that has no stand-in. */
  offSite: string[];
  /** A request to the Worker from Node, outside the browser; redirects are returned. */
  fetch: (path: string, init?: RequestInit) => Promise<Response>;
  /** Every email the Worker has queued so far, parsed (apps/mailer's message shape). */
  emails: () => Promise<EmailMessage[]>;
  close: () => Promise<void>;
};

// One /24 of TEST-NET-3 per process, counted, so each context gets an address of its own.
let nextIp = 0;
/** A client address no other context in this run has. */
export const freshIp = () => {
  nextIp += 1;
  return `203.0.${Math.floor(nextIp / 250) % 256}.${(nextIp % 250) + 1}`;
};

/**
 * Headless Chromium. With `port`, it resolves the site's host to the local Worker there, so it
 * visits the real origin: the Worker's same-origin checks, __Secure- cookies and CSP all hold.
 * Fails, saying how to install it, when Playwright's Chromium is missing.
 */
export async function launchChromium(port?: number): Promise<Browser> {
  try {
    return await chromium.launch({
      args: port === undefined ? [] : [`--host-resolver-rules=MAP ${HOST} 127.0.0.1:${port}`],
    });
  } catch (error) {
    // A missing browser must fail the run, never skip it.
    if (error instanceof Error && error.message.includes("Executable doesn't exist")) {
      throw new Error(
        "Playwright's Chromium is not installed. Run `npx playwright install chromium` " +
          "(on Linux CI, `npx playwright install --with-deps chromium`), then run again.",
        { cause: error },
      );
    }
    throw error;
  }
}

/**
 * Starts the site: a migrated test database, the web Worker on it in Miniflare, and headless
 * Chromium. Each suite starts its own and closes it in `afterAll`.
 */
export async function startSite({
  prelaunch = false,
  viewport = viewportFromEnv(),
}: SiteOptions = {}): Promise<Site> {
  const t = await createTestDb({ maxConnections: 64 });
  const worker = await startWorker({ databaseUrl: t.connectionString, prelaunch });
  const browser = await launchChromium(worker.port).catch(async (error: unknown) => {
    await worker.dispose();
    await t.close();
    throw error;
  });
  const db = createDb({ connectionString: t.connectionString, max: 1 });
  const bucket = await worker.mf.getR2Bucket("BUCKET");
  const emailSink = await worker.mf.getWorker("email-sink");
  const offSite: string[] = [];

  async function newContext({ ip = freshIp() }: ContextOptions = {}) {
    const context = await browser.newContext({
      viewport,
      // Miniflare's certificate is self-signed.
      ignoreHTTPSErrors: true,
      reducedMotion: "reduce",
      extraHTTPHeaders: { "cf-connecting-ip": ip },
    });
    await context.route(
      (url) => url.host !== HOST,
      async (route) => {
        const url = route.request().url();
        if (url.startsWith(TURNSTILE_SCRIPT)) {
          await route.fulfill({ contentType: "text/javascript", body: "" });
        } else if (url.startsWith(CONTENT)) {
          await route.fulfill({ contentType: "image/png", body: PIXEL });
        } else {
          offSite.push(url);
          await route.abort("blockedbyclient");
        }
      },
    );
    return context;
  }

  return {
    db,
    bucket,
    viewport,
    browser,
    newContext,
    offSite,
    fetch: (path, init = {}) =>
      worker.mf.dispatchFetch(new URL(path, SITE).toString(), { redirect: "manual", ...init }),
    async emails() {
      const res = await emailSink.fetch("https://email-sink/");
      // SAFETY: the sink answers with the JSON array of message bodies it was delivered.
      const bodies = (await res.json()) as unknown[];
      return bodies.map(parseMessage).filter((m): m is EmailMessage => m !== null);
    },
    async close() {
      await browser.close();
      await db.destroy();
      await worker.dispose();
      await t.close();
    },
  };
}
