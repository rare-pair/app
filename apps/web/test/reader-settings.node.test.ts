import { describe, expect, it } from "vitest";
import {
  CLEAR_FLASH_COOKIE,
  flashCookie,
  flashMessage,
  htmlAttributes,
  parseSettings,
  settingsCookie,
} from "../src/reader-settings";
import { SETTINGS_SCRIPT } from "../src/reader-settings";
import { STYLESHEET } from "../src/styles";

type Listener = (event: { target: { name: string; value: string } }) => void;

/**
 * Just enough of a page for the settings script: <html>'s dataset, a cookie jar that
 * records each write, and one settings form, hidden, whose change listeners it keeps.
 */
function fakePage(dataset: Record<string, string> = {}) {
  const writes: string[] = [];
  const listeners: Listener[] = [];
  // Each select shows the page's default until the script selects the reader's value.
  const selects = new Map([
    ["theme", { value: "" }],
    ["size", { value: "m" }],
    ["leading", { value: "normal" }],
    ["face", { value: "serif" }],
  ]);
  const form = {
    hidden: true,
    addEventListener(type: string, listener: Listener) {
      if (type === "change") listeners.push(listener);
    },
    elements: { namedItem: (name: string) => selects.get(name) ?? null },
  };
  const document = {
    documentElement: { dataset },
    set cookie(value: string) {
      writes.push(value);
    },
    querySelectorAll: (selector: string) => (selector === "form.reader-settings" ? [form] : []),
  };
  // The script's own source, run as the browser runs it, against this page.
  // oxlint-disable-next-line typescript/no-implied-eval -- the test runs the served script's source, as a browser would
  new Function("document", SETTINGS_SCRIPT)(document);
  const change = (name: string, value: string) =>
    listeners.forEach((listener) => listener({ target: { name, value } }));
  return { dataset, writes, form, selects, change };
}

describe("the settings script", () => {
  it("selects the reader's values from html's attributes", () => {
    // The reader bar is the same for every reader, so the script shows each one theirs.
    const page = fakePage({ theme: "sepia", size: "xl" });
    expect(Object.fromEntries(page.selects)).toEqual({
      theme: { value: "sepia" },
      size: { value: "xl" },
      leading: { value: "normal" },
      face: { value: "serif" },
    });
    expect(page.writes).toEqual([]);
  });

  it("Settings apply live with JS", () => {
    const page = fakePage({ theme: "dark" });
    // The controls are hidden until the script runs.
    expect(page.form.hidden).toBe(false);
    page.change("size", "xl");
    expect(page.dataset).toEqual({ theme: "dark", size: "xl" });
    // The same cookie, attributes and all, as the form's POST sets (settingsCookie), or
    // the browser would keep two.
    const written =
      "__Host-reader=theme=dark&size=xl; Max-Age=31536000; Path=/; SameSite=Lax; Secure";
    expect(page.writes).toEqual([written]);
    expect(settingsCookie({ theme: "dark", size: "xl" })).toBe(written);
  });

  it("drops the theme for the device's choice, and ignores other values", () => {
    const page = fakePage({ theme: "sepia", face: "sans" });
    page.change("theme", "");
    expect(page.dataset).toEqual({ face: "sans" });
    expect(page.writes).toEqual([
      "__Host-reader=face=sans; Max-Age=31536000; Path=/; SameSite=Lax; Secure",
    ]);
    page.change("size", "huge");
    page.change("next", "/elsewhere");
    page.change("__proto__", "x");
    expect(page.dataset).toEqual({ face: "sans" });
    expect(page.writes).toHaveLength(1);
  });

  it("never sets a style, writes markup or scrolls", () => {
    // The served source is the behaviour here: no API that could do any of these appears in it.
    // oxlint-disable-next-line deslop/no-poor-substring-tests -- the property is an absence over the whole served source
    expect(SETTINGS_SCRIPT).not.toMatch(/\.style\b|innerHTML|outerHTML|insertAdjacent|scroll/i);
  });
});

/** WCAG 2 relative luminance of a #rrggbb colour. */
const luminance = (hex: string) => {
  const [r = 0, g = 0, b = 0] = [1, 3, 5].map((i) => {
    const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

/** WCAG 2 contrast ratio of two #rrggbb colours. */
const contrast = (a: string, b: string) => {
  const [hi = 0, lo = 0] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

describe("theme colours", () => {
  it("contrast helper agrees with known WCAG values", () => {
    expect(contrast("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrast("#767676", "#ffffff")).toBeCloseTo(4.54, 2);
  });

  it("every theme's text, muted text and links pass AA (4.5:1) on its paper", () => {
    const blocks = {
      light: STYLESHEET.match(/^:root \{([^}]*)\}/)?.[1] ?? "",
      dark: STYLESHEET.match(/:root\[data-theme="dark"\] \{([^}]*)\}/)?.[1] ?? "",
      sepia: STYLESHEET.match(/:root\[data-theme="sepia"\] \{([^}]*)\}/)?.[1] ?? "",
    };
    for (const [theme, block] of Object.entries(blocks)) {
      const colour = (name: string) =>
        block.match(new RegExp(`--${name}:\\s*(#[0-9a-f]{6});`))?.[1] ?? "";
      const paper = colour("paper");
      expect(paper, theme).not.toBe("");
      for (const name of ["ink", "muted", "accent"]) {
        const fg = colour(name);
        expect(fg, `${theme} ${name}`).not.toBe("");
        expect(contrast(fg, paper), `${theme} ${name}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
});

// The settings cookie and the flash code are anyone's to write, so they are parsed
// against allowlists here, on the pure module; the Worker tests cover the routes.

describe("parseSettings", () => {
  it("keeps the allowlisted value of each setting", () => {
    expect(parseSettings("theme=dark&size=l&leading=relaxed&face=sans")).toEqual({
      theme: "dark",
      size: "l",
      leading: "relaxed",
      face: "sans",
    });
  });

  it("drops unknown keys and values, and anything with markup", () => {
    expect(parseSettings('theme="><script>&size=xxl&leading=RELAXED&face=sans&colour=red')).toEqual(
      { face: "sans" },
    );
  });

  it("reads nothing from an absent, empty or junk cookie", () => {
    expect(parseSettings(undefined)).toEqual({});
    expect(parseSettings("")).toEqual({});
    expect(parseSettings("x".repeat(4096))).toEqual({});
    expect(parseSettings("theme=dark=sepia")).toEqual({});
  });

  it("keeps the first of a repeated key", () => {
    expect(parseSettings("size=s&size=xl")).toEqual({ size: "s" });
  });
});

describe("htmlAttributes", () => {
  it("writes the settings as data attributes in a fixed order", () => {
    expect(htmlAttributes({ leading: "relaxed", size: "l", theme: "dark" })).toBe(
      ' data-theme="dark" data-size="l" data-leading="relaxed"',
    );
    expect(htmlAttributes({ face: "sans" })).toBe(' data-face="sans"');
    expect(htmlAttributes({})).toBe("");
  });
});

describe("settingsCookie", () => {
  it("is a __Host- cookie scripts can write, with no Domain", () => {
    expect(settingsCookie({ theme: "sepia", size: "xl" })).toBe(
      "__Host-reader=theme=sepia&size=xl; Max-Age=31536000; Path=/; SameSite=Lax; Secure",
    );
  });

  it("round-trips through parseSettings", () => {
    const settings = { theme: "light", size: "s", leading: "compact", face: "serif" } as const;
    const value = settingsCookie(settings).match(/^__Host-reader=([^;]*);/)?.[1];
    expect(parseSettings(value)).toEqual(settings);
  });
});

describe("flash", () => {
  it("maps a known code to fixed copy and anything else to nothing", () => {
    expect(flashMessage("settings-saved")).toBe("Reader settings saved.");
    expect(flashMessage("<b>hi</b>")).toBeNull();
    expect(flashMessage("toString")).toBeNull();
    expect(flashMessage(undefined)).toBeNull();
  });

  it("is a short-lived HttpOnly __Host- cookie, cleared with the same attributes", () => {
    expect(flashCookie("settings-saved")).toBe(
      "__Host-flash=settings-saved; Max-Age=60; Path=/; SameSite=Lax; Secure; HttpOnly",
    );
    expect(CLEAR_FLASH_COOKIE).toBe(
      "__Host-flash=; Max-Age=0; Path=/; SameSite=Lax; Secure; HttpOnly",
    );
  });
});
