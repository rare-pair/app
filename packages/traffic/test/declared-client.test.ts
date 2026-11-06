import { describe, expect, it } from "vitest";
import { CRAWLER_LIST } from "../src/crawler-list";
import { declaredClient } from "../src/index";

const ua = (userAgent: string) => new Headers({ "user-agent": userAgent });

// Real browsers, the headless one the browser suite drives, and tools that run in a browser.
const BROWSERS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/142.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36 Edg/142.0.0.0",
  "Mozilla/5.0 (X11; Linux x86_64; rv:144.0) Gecko/20100101 Firefox/144.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1",
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (Linux; Android 14; SM-S921B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 350.0.0.0",
];

describe("24-crawler-and-agent-blocking", () => {
  it("The crawler list ignores case", () => {
    expect(declaredClient(ua("Mozilla/5.0 (compatible; GPTBot/1.3)"))).toBe("crawler list");
    expect(declaredClient(ua("mozilla/5.0 (compatible; gptbot/1.3)"))).toBe("crawler list");
    expect(declaredClient(ua("MOZILLA/5.0 (COMPATIBLE; GPTBOT/1.3)"))).toBe("crawler list");
  });

  it("A word inside a browser's user agent is not a match", () => {
    const phone =
      "Mozilla/5.0 (Linux; Android 14; Aabotz X1) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Mobile Safari/537.36";
    expect(declaredClient(ua(phone))).toBeNull();
    for (const browser of BROWSERS) expect(declaredClient(ua(browser)), browser).toBeNull();
  });

  it("A Signature-Agent header is a declaration, whatever it holds", () => {
    const browser = BROWSERS[0]!;
    for (const value of ['"https://agent.example"', "anything", ""]) {
      const headers = new Headers({ "user-agent": browser, "signature-agent": value });
      expect(declaredClient(headers), value).toBe("signature");
    }
    expect(declaredClient(new Headers({ "signature-agent": "x" }))).toBe("signature");
  });

  it("A signature is the reason when both are sent", () => {
    const headers = new Headers({ "user-agent": "GPTBot/1.3", "signature-agent": "x" });
    expect(declaredClient(headers)).toBe("signature");
  });

  it("A missing or empty User-Agent is not a declaration", () => {
    expect(declaredClient(new Headers())).toBeNull();
    expect(declaredClient(ua(""))).toBeNull();
  });

  it("Each kind the spec names is on the list", () => {
    for (const client of [
      "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
      "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uagent.php)",
      "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ClaudeBot/1.0)",
      "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ChatGPT-User/1.0)",
      "Scrapy/2.13 (+https://scrapy.org)",
      "python-requests/2.32.3",
      "curl/8.7.1",
      "Instapaper/8.0",
    ]) {
      expect(declaredClient(ua(client)), client).toBe("crawler list");
    }
  });

  it("The list holds product names only, in lower case", () => {
    const tooBroad = ["bot", "crawl", "crawler", "spider", "agent", "fetch", "http", "node"];
    const automation = ["headless", "playwright", "puppeteer", "selenium", "webdriver", "phantom"];
    const assistive = ["jaws", "nvda", "voiceover", "talkback", "orca", "read-aloud"];
    expect(new Set(CRAWLER_LIST).size).toBe(CRAWLER_LIST.length);
    for (const name of CRAWLER_LIST) {
      expect(name, name).toBe(name.toLowerCase().trim());
      expect(name.length, name).toBeGreaterThanOrEqual(5);
      expect(tooBroad, name).not.toContain(name);
      for (const word of [...automation, ...assistive]) expect(name, name).not.toContain(word);
    }
  });
});
