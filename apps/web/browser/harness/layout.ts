import type { Page } from "playwright";

/**
 * Whether the page scrolls sideways at its viewport's width: the document is wider than the
 * window (the web protocol's 360 px check, `scrollWidth <= innerWidth`).
 */
export const hasSidewaysScroll = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
