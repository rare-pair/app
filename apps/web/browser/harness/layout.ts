import type { Page } from "playwright";

/** A box's edges in the window, as `getBoundingClientRect` reports them. */
export type Box = { left: number; right: number; top: number; bottom: number; width: number };

/** The page's scroll height, the window's size, and the boxes of the site's chrome. */
export type Fill = {
  scrollHeight: number;
  innerHeight: number;
  innerWidth: number;
  header: Box;
  main: Box;
  footer: Box;
  /** Null when the page has no banner. */
  banner: Box | null;
};

/** Measures the page where it opens (scrolled to the top). */
export const measureFill = (page: Page): Promise<Fill> =>
  page.evaluate(() => {
    const box = (selector: string) => {
      const el = document.querySelector(selector);
      if (!el) return null;
      const { left, right, top, bottom, width } = el.getBoundingClientRect();
      return { left, right, top, bottom, width };
    };
    return {
      scrollHeight: document.documentElement.scrollHeight,
      innerHeight: window.innerHeight,
      innerWidth: window.innerWidth,
      header: box("body > header")!,
      main: box("main")!,
      footer: box("body > footer")!,
      banner: box(".banner"),
    };
  });

/** The footer's bottom edge in the window after scrolling the page to its end. */
export const footerBottomAtEnd = (page: Page) =>
  page.evaluate(() => {
    window.scrollTo(0, document.documentElement.scrollHeight);
    return document.querySelector("body > footer")!.getBoundingClientRect().bottom;
  });

/**
 * Whether the page scrolls sideways at its viewport's width: the document is wider than the
 * window (the web protocol's 360 px check, `scrollWidth <= innerWidth`).
 */
export const hasSidewaysScroll = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);

/**
 * Up to five elements that reach past the window's right edge, each as `tag.class (width)`,
 * to name what makes a page scroll sideways. Left out: absolutely positioned elements (the
 * skip link, visually hidden text) and what is inside a box that scrolls or clips itself.
 */
export const sidewaysOffenders = (page: Page) =>
  page.evaluate(() => {
    const found: string[] = [];
    for (const el of document.body.querySelectorAll("*")) {
      if (found.length === 5) break;
      const box = el.getBoundingClientRect();
      if (box.width === 0 || box.right <= window.innerWidth) continue;
      // Not what a reader sees: an absolutely positioned box (or anything in one), or
      // anything in a box that scrolls or clips its own overflow.
      let hidden = false;
      for (let at: Element | null = el; at && at !== document.body; at = at.parentElement) {
        const style = getComputedStyle(at);
        if (style.position === "absolute" || (at !== el && style.overflowX !== "visible")) {
          hidden = true;
          break;
        }
      }
      if (hidden) continue;
      const name = el.id
        ? `#${el.id}`
        : el.classList.length > 0
          ? `.${[...el.classList].join(".")}`
          : "";
      found.push(
        `${el.tagName.toLowerCase()}${name} (${Math.round(box.width)}px wide, right edge ${Math.round(box.right)})`,
      );
    }
    return found;
  });
