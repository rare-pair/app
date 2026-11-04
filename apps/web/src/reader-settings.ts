// Reader settings (ARCHITECTURE, Reading): theme, size, line spacing and face, kept in
// a cookie and written as data-* attributes on <html>, which the stylesheet keys off.
// Pure, so it runs in Node: the routes are in settings.ts and the middleware that
// writes the attributes in page-state.ts.

import { fnv1a } from "./styles";

/** Each setting and the values it may take, in the order they are written. */
export const SETTINGS = {
  theme: ["light", "dark", "sepia"],
  size: ["s", "m", "l", "xl"],
  leading: ["compact", "normal", "relaxed"],
  face: ["serif", "sans"],
} as const;

export type SettingName = keyof typeof SETTINGS;
export type Settings = { [K in SettingName]?: (typeof SETTINGS)[K][number] };

// SAFETY: the keys of SETTINGS, which Object.keys types only as string.
export const SETTING_NAMES = Object.keys(SETTINGS) as SettingName[];

/**
 * Whether `value` is one `name` may take. A plain lookup in the lists above, so a
 * value from a cookie or a form is never written anywhere unless it is one of them.
 */
export const isSettingValue = <K extends SettingName>(
  name: K,
  value: string | null | undefined,
): value is NonNullable<Settings[K]> => {
  // SAFETY: widening the list's literal types to string only lets includes take any string.
  const list = SETTINGS[name] as readonly string[];
  return list.includes(value ?? "");
};

/** Sets one setting to a value its list allows. */
export const setSetting = <K extends SettingName>(
  settings: Settings,
  name: K,
  value: NonNullable<Settings[K]>,
) => {
  settings[name] = value;
};

/**
 * The settings cookie's name. `__Host-`: Secure, Path=/ and no Domain, so it never
 * reaches the content origin. Not HttpOnly: the settings script writes it, and it holds
 * only the display values above, nothing that identifies anyone.
 */
export const SETTINGS_COOKIE = "__Host-reader";
// A year, renewed whenever the reader changes something. The script writes the same.
export const SETTINGS_COOKIE_ATTRIBUTES = "; Max-Age=31536000; Path=/; SameSite=Lax; Secure";

/**
 * The settings a cookie value holds, such as `theme=dark&size=l`. Unknown keys and any
 * value outside its list are dropped; of a repeated key, the first is kept.
 */
export function parseSettings(value: string | undefined): Settings {
  const settings: Settings = {};
  if (!value) return settings;
  const fields = new URLSearchParams(value);
  for (const name of SETTING_NAMES) {
    const field = fields.get(name);
    if (isSettingValue(name, field)) setSetting(settings, name, field);
  }
  return settings;
}

/** The cookie's value: each setting that is set, as `name=value`, in a fixed order. */
const serializeSettings = (settings: Settings) =>
  SETTING_NAMES.flatMap((name) => {
    const value = settings[name];
    return isSettingValue(name, value) ? [`${name}=${value}`] : [];
  }).join("&");

/** The whole `Set-Cookie` value that stores `settings`. */
export const settingsCookie = (settings: Settings) =>
  `${SETTINGS_COOKIE}=${serializeSettings(settings)}${SETTINGS_COOKIE_ATTRIBUTES}`;

/**
 * The attributes for <html>, as name and value: only values from the lists, so the
 * cookie's own text is never echoed.
 */
export const dataAttributes = (settings: Settings): [string, string][] =>
  SETTING_NAMES.flatMap((name) => {
    const value = settings[name];
    return isSettingValue(name, value) ? [[`data-${name}`, value]] : [];
  });

/** The same attributes as markup, each with a leading space. */
export const htmlAttributes = (settings: Settings) =>
  dataAttributes(settings)
    .map(([name, value]) => ` ${name}="${value}"`)
    .join("");

/**
 * The settings script, served from SETTINGS_SCRIPT_PATH and loaded with the page's
 * nonce. It shows the reader bar's hidden settings form with the reader's values
 * selected, and on any change flips that
 * attribute on <html> and writes the same cookie the form's POST sets, so the next page
 * the server renders agrees. It sets no style, writes no markup and never scrolls.
 */
export const SETTINGS_SCRIPT = `"use strict";
(() => {
  const LISTS = ${JSON.stringify(SETTINGS)};
  const NAMES = ${JSON.stringify(SETTING_NAMES)};
  const COOKIE = ${JSON.stringify(SETTINGS_COOKIE)};
  const ATTRIBUTES = ${JSON.stringify(SETTINGS_COOKIE_ATTRIBUTES)};
  const data = document.documentElement.dataset;
  const allowed = (name, value) =>
    Object.prototype.hasOwnProperty.call(LISTS, name) && LISTS[name].includes(value);
  for (const form of document.querySelectorAll("form.reader-settings")) {
    // The reader bar is the same for every reader: show this reader's values in it.
    for (const name of NAMES) {
      const field = form.elements.namedItem(name);
      if (field && allowed(name, data[name])) field.value = data[name];
    }
    form.hidden = false;
    form.addEventListener("change", (event) => {
      const { name, value } = event.target;
      if (allowed(name, value)) data[name] = value;
      else if (name === "theme" && value === "") delete data.theme;
      else return;
      const fields = NAMES.filter((n) => allowed(n, data[n])).map((n) => n + "=" + data[n]);
      document.cookie = COOKIE + "=" + fields.join("&") + ATTRIBUTES;
    });
  }
})();
`;

/** The script's URL carries a hash of it, so the response never changes under it. */
export const SETTINGS_SCRIPT_PATH = `/assets/reader-settings.${fnv1a(SETTINGS_SCRIPT)}.js`;

/**
 * The one-shot flash cookie: a code from FLASHES, never copy or markup, so a forged
 * cookie can show nothing but our own sentences. HttpOnly, since no script reads it.
 */
export const FLASH_COOKIE = "__Host-flash";
const FLASH_ATTRIBUTES = "; Path=/; SameSite=Lax; Secure; HttpOnly";

// Draft copy for the operator to proof.
const FLASHES = new Map([["settings-saved", "Reader settings saved."]]);
export type FlashCode = "settings-saved";

/** The copy for a flash code, or null for any code not in the table. */
export const flashMessage = (code: string | undefined) =>
  (code === undefined ? undefined : FLASHES.get(code)) ?? null;

/** Sets the flash, for the next page that can show it, within a minute: usually the one the redirect lands on. */
export const flashCookie = (code: FlashCode) =>
  `${FLASH_COOKIE}=${code}; Max-Age=60${FLASH_ATTRIBUTES}`;

/** Clears the flash once a page has shown it. A `__Host-` cookie is cleared only with the same attributes. */
export const CLEAR_FLASH_COOKIE = `${FLASH_COOKIE}=; Max-Age=0${FLASH_ATTRIBUTES}`;
