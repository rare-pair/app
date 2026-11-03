import type { JSHandle, Page } from "playwright";

/** What pressing Tab through a page found. Each element is named as `controlsOf` names it. */
export type TabWalk = {
  /** Where focus went, in order, until it left the page or came round again. */
  stops: string[];
  /** Controls a keyboard user should reach that Tab never focused. */
  unreached: string[];
  /** Focused elements with no visible focus ring. */
  withoutRing: string[];
  /** Stops that came before an element earlier in the page. */
  outOfOrder: string[];
};

// What a keyboard user must be able to reach: links, form controls, and anything given a
// place in the tab order. Hidden inputs, disabled controls and anything inert are left out
// below, as are elements with no box (inside a closed <details>, or display: none).
const CONTROLS =
  'a[href], button, input:not([type="hidden"]), select, textarea, summary, ' +
  '[tabindex]:not([tabindex="-1"])';

/** The page's controls, held in the page, and their names, in page order. */
type Controls = {
  handle: JSHandle<{ els: HTMLElement[]; stopOf: (el: Element) => Element }>;
  names: string[];
};

/**
 * Every control a keyboard user should reach, in page order. A radio group is one control,
 * its first radio, as Tab makes it one stop. Each is named by its tag and then its text, or
 * by its kind and form name for a field: `a "About"`, `button "Search"`, `input q`,
 * `radio reason`, `select theme`.
 */
async function controlsOf(page: Page): Promise<Controls> {
  const handle = await page.evaluateHandle((selector) => {
    // The element standing for el's tab stop: the first radio of its group (same name, same
    // form) for a radio, el itself for anything else.
    const stopOf = (el: Element) =>
      el instanceof HTMLInputElement && el.type === "radio"
        ? ([...document.querySelectorAll("input[type=radio]")].find(
            (r) => r instanceof HTMLInputElement && r.name === el.name && r.form === el.form,
          ) ?? el)
        : el;
    const els = [...document.querySelectorAll<HTMLElement>(selector)].filter((el) => {
      if (el.closest("[inert]") !== null || el.matches(":disabled")) return false;
      if (el.getClientRects().length === 0 || getComputedStyle(el).visibility === "hidden") {
        return false;
      }
      return stopOf(el) === el;
    });
    return { els, stopOf };
  }, CONTROLS);
  const names = await handle.evaluate(({ els }) =>
    els.map((el) => {
      if (el instanceof HTMLInputElement) {
        return el.type === "radio" ? `radio ${el.name}` : `input ${el.name}`;
      }
      if (el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement) {
        return `${el.tagName.toLowerCase()} ${el.name}`;
      }
      return `${el.tagName.toLowerCase()} "${el.textContent.trim().replace(/\s+/g, " ")}"`;
    }),
  );
  return { handle, names };
}

/**
 * Which control has focus: its index among `controls`, -1 for an element that isn't one, or
 * null when focus is on no element of the page (the body, or the browser's own UI). A radio
 * stands for its group. `ring` is whether it shows a focus ring: an outline 2 px or wider.
 */
const focused = (controls: Controls) =>
  controls.handle.evaluate(({ els, stopOf }) => {
    const active = document.activeElement;
    if (active === null || active === document.body) return { index: null, ring: false };
    const stop = stopOf(active);
    const index = els.findIndex((el) => el === stop);
    const style = getComputedStyle(active);
    const ring = style.outlineStyle !== "none" && Number.parseFloat(style.outlineWidth) >= 2;
    return { index, ring };
  });

/**
 * Presses Tab from where focus is (the top of a page just loaded) until focus leaves the
 * page or comes back round, and compares where it went with every control in the page.
 */
export async function tabWalk(page: Page): Promise<TabWalk> {
  const controls = await controlsOf(page);
  const stops: string[] = [];
  const reached = new Set<number>();
  const withoutRing: string[] = [];
  const outOfOrder: string[] = [];
  let last = -1;
  try {
    // Every control once, and a few presses over, in case focus passes elsewhere first.
    for (let press = 0; press < controls.names.length + 5; press += 1) {
      await page.keyboard.press("Tab");
      const { index, ring } = await focused(controls);
      if (index === null || reached.has(index)) break;
      if (index === -1) continue;
      const name = controls.names[index] ?? "";
      stops.push(name);
      reached.add(index);
      if (!ring) withoutRing.push(name);
      if (index < last) outOfOrder.push(name);
      last = index;
    }
  } finally {
    await controls.handle.dispose();
  }
  return {
    stops,
    unreached: controls.names.filter((_, i) => !reached.has(i)),
    withoutRing,
    outOfOrder,
  };
}

/** The walk's problems as text, one line each; empty when there are none. */
export const formatWalk = ({ unreached, withoutRing, outOfOrder }: TabWalk) =>
  [
    ...unreached.map((name) => `not reached by Tab: ${name}`),
    ...withoutRing.map((name) => `no focus ring: ${name}`),
    ...outOfOrder.map((name) => `out of page order: ${name}`),
  ].join("\n");

/**
 * Presses Tab until the first control named `name` (as `tabWalk` names it) has focus, as a
 * keyboard user gets to it. Throws if Tab passes it by or never comes to it.
 */
export async function tabTo(page: Page, name: string): Promise<void> {
  const controls = await controlsOf(page);
  try {
    const target = controls.names.indexOf(name);
    if (target === -1) throw new Error(`no control named ${name} on ${page.url()}`);
    for (let press = 0; press < controls.names.length + 5; press += 1) {
      await page.keyboard.press("Tab");
      const { index } = await focused(controls);
      if (index === target) return;
    }
    throw new Error(`Tab never reached ${name} on ${page.url()}`);
  } finally {
    await controls.handle.dispose();
  }
}
