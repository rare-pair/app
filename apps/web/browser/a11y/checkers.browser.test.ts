import type { Browser, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchChromium } from "../harness/site";
import { checkAxe, formatResults } from "./axe";

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

  it("runs target-size (WCAG 2.2, 2.5.8), which axe leaves off by default", async () => {
    await content(
      `<p><button style="width:10px;height:10px;padding:0;border:0">a</button>` +
        `<button style="width:10px;height:10px;padding:0;border:0">b</button></p>`,
    );
    const { violations } = await checkAxe(page);
    expect(violations.map((v) => v.id)).toContain("target-size");
  });
});
