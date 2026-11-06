import { expect } from "vitest";
import type { Page } from "playwright";

/**
 * The agent notice is in the page, but takes up no room, moves nothing, and isn't in what a
 * screen reader is given (specs/scenarios/mvp/24-crawler-and-agent-blocking.md).
 */
export const expectAgentNoticeHidden = async (page: Page) => {
  const notice = page.locator("main p", { hasText: "To AI agents and crawlers" });
  expect(await notice.count()).toBe(1);
  const box = await notice.boundingBox();
  expect(box?.width).toBeLessThanOrEqual(1);
  expect(box?.height).toBeLessThanOrEqual(1);
  expect(await notice.evaluate((el) => getComputedStyle(el).position)).toBe("absolute");
  expect(await page.locator("main").ariaSnapshot()).not.toContain("To AI agents");
  const sideways = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(sideways).toBe(0);
};
