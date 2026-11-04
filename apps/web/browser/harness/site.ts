import type { Database, UploadStatus } from "@archive/db";
import { createTestDb } from "@archive/db/testing";
import type { Kysely } from "kysely";
import type { Miniflare, RequestInit, Response } from "miniflare";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { inject } from "vitest";
import { parseMessage, type EmailMessage } from "../../../mailer/src/message";
import { CONTENT_HOST } from "../../src/content-host";
import { SITE } from "../../src/signin";
import { DUMMY_TOKEN } from "../../test/stand-ins";
import { cleanCheck, type CleanOptions } from "./clean";
import { R2_HOST } from "./r2-put";
import { recorderFromEnv } from "./recording";
import { startWorker } from "./worker";

/** Where the browser visits: the real site's origin, mapped to the local Worker. */
export { SITE };
/** The hosts Chromium resolves to Miniflare: web, content, and the stand-in for R2's endpoint. */
const LOCAL_HOSTS = [new URL(SITE).host, CONTENT_HOST, R2_HOST];
// Stood in for in the browser, never fetched.
const TURNSTILE_SCRIPT = "https://challenges.cloudflare.com/turnstile/v0/api.js";
const UPLOAD_WAIT_MS = 30_000;
/**
 * Turnstile's script, standing in: every widget is solved at once with Cloudflare's dummy
 * token under the widget's action, which test/stand-ins.ts's siteverify passes. As the real
 * script does, it adds the token to the widget's form as `cf-turnstile-response` and calls
 * the widget's `data-callback` with it, and `turnstile.getResponse()` and `reset()` work. It
 * draws no frame.
 */
const TURNSTILE_STUB = /* js */ `
const tokens = [];
window.turnstile = { getResponse: () => tokens[0], reset: () => {} };
const solve = () => {
  for (const widget of document.querySelectorAll(".cf-turnstile")) {
    const input = document.createElement("input");
    input.type = "hidden";
    input.name = "cf-turnstile-response";
    input.value = ${JSON.stringify(`${DUMMY_TOKEN}#`)} + (widget.dataset.action || "");
    widget.append(input);
    tokens.push(input.value);
    // As the real widget does once solved: call the page's data-callback with the token.
    const callback = window[widget.dataset.callback || ""];
    if (typeof callback === "function") callback(input.value);
  }
};
// The script loads async, so it may run before the widgets are parsed: wait for them.
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", solve);
else solve();
`;
export type Viewport = { width: number; height: number };

/**
 * The viewport `BROWSER_VIEWPORT` names, as `<width>x<height>` ("360x640"), or 1280 by 800
 * when it is unset. Throws on anything else, so a typo never runs the suite at the default.
 */
export function viewportFromEnv(value = process.env.BROWSER_VIEWPORT): Viewport {
  if (value === undefined || value === "") return { width: 1280, height: 800 };
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
  /** Whether the context runs scripts. Default: true; false is a browser with JavaScript off. */
  javaScript?: boolean;
};

/** The running site: the Workers, their database and bucket, and a browser to visit them with. */
export type Site = {
  /** The database the Workers read, for seeding and for reading what they stored. */
  db: Kysely<Database>;
  /** The R2 bucket the Workers share, for seeding fragments and reading what they stored. */
  bucket: Awaited<ReturnType<Miniflare["getR2Bucket"]>>;
  /**
   * A new browser context on the site. The content host is the real content Worker, a presigned
   * PUT goes to the stand-in for R2's endpoint (r2-put.ts), and Turnstile's script is stood in
   * for, solving every widget at once. Any other request off the site is refused and recorded
   * in `offSite`.
   */
  newContext: (options?: ContextOptions) => Promise<BrowserContext>;
  /** Every off-site URL a page asked for that has no stand-in. */
  offSite: string[];
  /** A request to a Worker from Node, by path on the site or full URL; redirects are returned. */
  fetch: (path: string, init?: RequestInit) => Promise<Response>;
  /** Every email the Worker has queued so far, parsed (apps/mailer's message shape). */
  emails: () => Promise<EmailMessage[]>;
  /**
   * Waits for the ingest Worker to finish upload `id`, polling its row. Resolves once it is
   * `expected` (default `live`, written last, so the work and its objects are all there).
   * Throws at once, naming the status, if the job ends any other way, and after 30 seconds.
   */
  waitForUpload: (
    id: string,
    expected?: Exclude<UploadStatus, "pending" | "processing">,
  ) => Promise<void>;
  /**
   * Throws, listing every CSP violation, console or script error and off-site request in any
   * of the site's contexts since the last call. `allow` excuses the problems it matches.
   * `useJourneySite` (journey.ts) calls it after every test.
   */
  assertClean: (options?: CleanOptions) => Promise<void>;
  /** Every browser context open now. */
  contexts: () => BrowserContext[];
  /** Leaves `page` out of the `BROWSER_RECORD` videos: a step of setup, not of the test. */
  dropRecording: (page: Page) => void;
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
      args:
        port === undefined
          ? []
          : [
              `--host-resolver-rules=${LOCAL_HOSTS.map((host) => `MAP ${host} 127.0.0.1:${port}`).join(", ")}`,
            ],
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
 * Starts the site: a migrated test database, the web, ingest and content Workers on it in
 * Miniflare (from the run's bundles, global-setup.ts), and headless Chromium. Close it in
 * `afterAll`.
 */
export async function startSite({
  prelaunch = false,
  viewport = viewportFromEnv(),
}: SiteOptions = {}): Promise<Site> {
  const t = await createTestDb({ maxConnections: 64 });
  let worker: Awaited<ReturnType<typeof startWorker>> | undefined;
  let browser: Browser | undefined;
  const recorder = recorderFromEnv();
  /** Stops whatever has started, each part even if another fails to stop. */
  const stop = async () => {
    try {
      await recorder?.finish();
    } finally {
      try {
        await browser?.close();
      } finally {
        try {
          await worker?.mf.dispose();
        } finally {
          await t.close();
        }
      }
    }
  };
  let parts;
  try {
    worker = await startWorker({
      bundles: inject("workerBundles"),
      databaseUrl: t.connectionString,
      prelaunch,
    });
    browser = await launchChromium(worker.port);
    parts = {
      mf: worker.mf,
      chromium: browser,
      bucket: await worker.mf.getR2Bucket("BUCKET", "rarepair-web"),
      emailSink: await worker.mf.getWorker("email-sink"),
    };
  } catch (error) {
    await stop();
    throw error;
  }
  const { mf, chromium: running, bucket, emailSink } = parts;
  const offSite: string[] = [];
  const check = cleanCheck(offSite);

  async function newContext({ ip = freshIp(), javaScript = true }: ContextOptions = {}) {
    const context = await running.newContext({
      viewport,
      javaScriptEnabled: javaScript,
      // Miniflare's certificate is self-signed.
      ignoreHTTPSErrors: true,
      reducedMotion: "reduce",
      extraHTTPHeaders: { "cf-connecting-ip": ip },
      ...recorder?.contextOptions,
    });
    check.watch(context);
    recorder?.watch(context);
    await context.route(
      (url) => !LOCAL_HOSTS.includes(url.host),
      async (route) => {
        const url = route.request().url();
        if (url.startsWith(TURNSTILE_SCRIPT)) {
          await route.fulfill({ contentType: "text/javascript", body: TURNSTILE_STUB });
        } else {
          offSite.push(url);
          await route.abort("blockedbyclient");
        }
      },
    );
    return context;
  }

  return {
    db: t.db,
    bucket,
    newContext,
    offSite,
    fetch: (path, init = {}) =>
      mf.dispatchFetch(new URL(path, SITE).toString(), { redirect: "manual", ...init }),
    async emails() {
      const res = await emailSink.fetch("https://email-sink/");
      // SAFETY: the sink answers with the JSON array of message bodies it was delivered.
      const bodies = (await res.json()) as unknown[];
      return bodies.map(parseMessage).filter((m): m is EmailMessage => m !== null);
    },
    async waitForUpload(id, expected = "live") {
      const deadline = Date.now() + UPLOAD_WAIT_MS;
      for (;;) {
        const { status, error_stage: stage } = await t.db
          .selectFrom("uploads")
          .select(["status", "error_stage"])
          .where("id", "=", id)
          .executeTakeFirstOrThrow();
        if (status === expected) return;
        if (status !== "pending" && status !== "processing") {
          throw new Error(`upload ${id} ended ${status} (stage ${stage}), not ${expected}`);
        }
        if (Date.now() > deadline) {
          throw new Error(`upload ${id} still ${status} after ${UPLOAD_WAIT_MS} ms`);
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    },
    assertClean: check.assertClean,
    contexts: () => running.contexts(),
    dropRecording: (page) => recorder?.drop(page),
    close: stop,
  };
}
