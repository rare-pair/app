import { createRequire } from "node:module";
import type { Browser, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hasSidewaysScroll, sidewaysOffenders } from "../harness/layout";
import { launchChromium, viewportFromEnv } from "../harness/site";
import { checkAxe, formatResults } from "./axe";
import { formatWalk, tabWalk } from "./keyboard";

// The checkers themselves, on pages written here: each must fail what it is there to catch,
// or a pass on the site's pages shows nothing.

let browser: Browser;
let page: Page;

beforeAll(async () => {
  browser = await launchChromium();
  page = await (await browser.newContext()).newPage();
});
afterAll(() => browser.close());

/** A page with `body` in its <main>, and every other part of a passing page around it. */
const content = (body: string, head = "") =>
  page.setContent(
    `<!doctype html><html lang="en"><head><title>Checker</title>${head}</head>` +
      `<body><main><h1>Checker</h1>${body}</main></body></html>`,
  );

describe("checkers: axe", () => {
  it("fails low-contrast text, naming the rule and the element", async () => {
    await content(`<p id="faint" style="color:#bbbbbb;background:#ffffff">Faint text</p>`);
    const { violations } = await checkAxe(page);
    expect(violations.map((v) => v.id)).toEqual(["color-contrast"]);
    const report = formatResults(violations);
    expect(report).toContain("color-contrast");
    expect(report).toContain("#faint");
  });

  it("passes the same text at full contrast", async () => {
    await content(`<p style="color:#000000;background:#ffffff">Plain text</p>`);
    expect(formatResults((await checkAxe(page)).violations)).toBe("");
  });

  it("reports best-practice rules apart, without failing on them", async () => {
    await page.setContent(
      `<!doctype html><html lang="en"><head><title>Checker</title></head>` +
        `<body><h1>Checker</h1><p>No main landmark.</p></body></html>`,
    );
    const { violations, bestPractice } = await checkAxe(page);
    expect(formatResults(violations)).toBe("");
    expect(bestPractice.map((r) => r.id)).toContain("landmark-one-main");
  });

  it("runs target-size (WCAG 2.2, 2.5.8), which axe leaves off by default", async () => {
    await content(
      `<p><button style="width:10px;height:10px;padding:0;border:0">a</button>` +
        `<button style="width:10px;height:10px;padding:0;border:0">b</button></p>`,
    );
    const { violations } = await checkAxe(page);
    expect(violations.map((v) => v.id)).toContain("target-size");
  });
});

// A focus ring on every control in the accent colour, as the site gives one (src/styles.ts).
const RING =
  "<style>:root { --accent: #0b5cad } " +
  ":focus-visible { outline: 2px solid var(--accent); outline-offset: 2px }</style>";

describe("checkers: keyboard", () => {
  it("passes a page whose every control the Tab key reaches, with a ring", async () => {
    await content(
      `<a href="#one">One</a><form><input name="q" aria-label="Query">` +
        `<label><input type="radio" name="r" value="a"> A</label>` +
        `<label><input type="radio" name="r" value="b"> B</label>` +
        `<button>Go</button></form>`,
      RING,
    );
    const walk = await tabWalk(page);
    expect(formatWalk(walk)).toBe("");
    expect(walk.stops).toEqual(['a "One"', "input q", "radio r", 'button "Go"']);
  });

  it("fails a control the Tab key skips", async () => {
    await content(`<a href="#one">One</a><button tabindex="-1">Skipped</button>`, RING);
    expect(formatWalk(await tabWalk(page))).toContain('not reached by Tab: button "Skipped"');
  });

  it("fails a control focused with no visible ring", async () => {
    await content(`<a href="#one" style="outline: none">One</a>`, RING);
    expect(formatWalk(await tabWalk(page))).toContain('no focus ring: a "One"');
  });

  it("fails a ring drawn in a transparent colour", async () => {
    await content(`<a href="#one" style="outline: 2px solid transparent">One</a>`, RING);
    expect(formatWalk(await tabWalk(page))).toContain('no focus ring: a "One"');
  });

  it("fails a ring that isn't in the accent colour", async () => {
    await content(`<a href="#one" style="outline: 2px solid #888888">One</a>`, RING);
    expect(formatWalk(await tabWalk(page))).toContain('no focus ring: a "One"');
  });

  it("fails a stop that isn't a listed control, if it has no ring", async () => {
    await content(`<div contenteditable style="outline: none">Edit me</div>`, RING);
    expect(formatWalk(await tabWalk(page))).toContain("no focus ring: other div");
  });

  it("fails a tab order that jumps back up the page", async () => {
    await content(`<a href="#one">One</a><a href="#two" tabindex="1">Two</a>`, RING);
    expect(formatWalk(await tabWalk(page))).toContain('out of page order: a "One"');
  });
});

describe("harness: the Worker's runtime", () => {
  it("runs the miniflare (so the workerd) that wrangler deploys and tests with", () => {
    const require = createRequire(import.meta.url);
    // SAFETY: package.json files, read for one string field.
    const wrangler = require("wrangler/package.json") as { dependencies: { miniflare: string } };
    // SAFETY: as above.
    const ours = require("../../package.json") as { devDependencies: { miniflare: string } };
    expect(ours.devDependencies.miniflare).toBe(wrangler.dependencies.miniflare);
  });
});

// What Q1c (#510) needs to run the inventory at 360 px: one option, and the check.
describe("harness: a narrow viewport", () => {
  it("BROWSER_VIEWPORT names the window, and a typo fails rather than runs at the default", () => {
    expect(viewportFromEnv("360x640")).toEqual({ width: 360, height: 640 });
    expect(viewportFromEnv(undefined)).toEqual({ width: 1280, height: 800 });
    expect(() => viewportFromEnv("360")).toThrow(/BROWSER_VIEWPORT/);
  });

  it("finds a page that scrolls sideways at 360 px, and one that doesn't", async () => {
    const narrow = await browser.newContext({ viewport: viewportFromEnv("360x640") });
    const small = await narrow.newPage();
    try {
      await small.setContent(`<div style="width: 500px">Too wide</div>`);
      expect(await hasSidewaysScroll(small)).toBe(true);
      await small.setContent(`<p>Wraps to fit</p>`);
      expect(await hasSidewaysScroll(small)).toBe(false);
    } finally {
      await narrow.close();
    }
  });

  it("names the element that is too wide, and nothing for a page that fits", async () => {
    const narrow = await browser.newContext({ viewport: viewportFromEnv("360x640") });
    const small = await narrow.newPage();
    try {
      // The skip link's box and its child reach past the edge but aren't what a reader sees.
      await small.setContent(
        `<p>Fits</p><div class="wide" style="width: 500px">Too wide</div>` +
          `<a style="position: absolute; left: 400px">Skip <span>link</span></a>` +
          `<div style="overflow: auto"><pre style="width: 700px">scrolls inside</pre></div>`,
      );
      expect(await sidewaysOffenders(small)).toEqual(["div.wide (500px wide, right edge 508)"]);
      await small.setContent(`<p>Wraps to fit</p>`);
      expect(await sidewaysOffenders(small)).toEqual([]);
    } finally {
      await narrow.close();
    }
  });
});
