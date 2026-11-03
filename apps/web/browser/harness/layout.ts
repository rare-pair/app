import type { Page } from "playwright";

/**
 * Whether the page scrolls sideways at its viewport's width: the document is wider than the
 * window (the web protocol's 360 px check, `scrollWidth <= innerWidth`).
 */
export const hasSidewaysScroll = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);

/**
 * Up to five elements that reach past the window's right edge, each as `tag.class (width)`,
 * to name what makes a page scroll sideways. Absolutely positioned elements (the skip link,
 * visually hidden text) are left out: they are not what a reader sees.
 */
export const sidewaysOffenders = (page: Page) =>
  page.evaluate(() => {
    const found: string[] = [];
    for (const el of document.body.querySelectorAll("*")) {
      if (found.length === 5) break;
      const box = el.getBoundingClientRect();
      if (box.width === 0 || box.right <= window.innerWidth) continue;
      if (getComputedStyle(el).position === "absolute") continue;
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
