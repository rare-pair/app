// /settings/reader: the reader settings form, which works with JavaScript off. It
// sets the settings cookie and a flash, then sends the reader back where they came
// from. No account is needed: the display settings are only a cookie. A signed-in
// reader also gets the warnings screen choice, which is stored on the account.

import type { Context } from "hono";
import { getCookie } from "hono/cookie";
import type { Bindings } from "./env";
import { readForm } from "./login";
import { escapeHtml, forbiddenPage, layout } from "./pages";
import {
  flashCookie,
  isSettingValue,
  parseSettings,
  SETTING_NAMES,
  SETTINGS_COOKIE,
  SETTINGS_SCRIPT_PATH,
  setSetting,
  settingsCookie,
  type SettingName,
  type Settings,
} from "./reader-settings";
import type { SecurityVariables } from "./security";
import type { SessionVariables } from "./session";
import { isSameOrigin, safeNext } from "./signin";
import { setWarningsOff } from "./warnings-off";

type SettingsContext = Context<{
  Bindings: Bindings;
  Variables: SecurityVariables & SessionVariables;
}>;

// The warnings screen choice, for signed-in readers only: a select, so a post always
// says which, and one that lacks it (the reader bar's) leaves the account alone. Draft
// copy for the operator to proof.
const WARNINGS_FIELD = "warnings_screen";
const warningsControl = (off: boolean) =>
  `<label for="settings-warnings">Rating and warnings screen</label>
<select id="settings-warnings" name="${WARNINGS_FIELD}"><option value="show"${off ? "" : " selected"}>Show before a work's text</option><option value="skip"${off ? " selected" : ""}>Skip it</option></select>
`;

/** The settings form's path, the form's action and the reader bar's link. */
export const SETTINGS_PATH = "/settings/reader";

// Each control's label and its options' labels, in the order shown. Draft copy for the
// operator to proof. The theme's empty value stores no theme, so the device decides.
const CONTROLS: Record<SettingName, { label: string; options: [string, string][] }> = {
  theme: {
    label: "Theme",
    options: [
      ["", "Match my device"],
      ["light", "Light"],
      ["dark", "Dark"],
      ["sepia", "Sepia"],
    ],
  },
  size: {
    label: "Text size",
    options: [
      ["s", "Small"],
      ["m", "Medium"],
      ["l", "Large"],
      ["xl", "Extra large"],
    ],
  },
  leading: {
    label: "Line spacing",
    options: [
      ["compact", "Compact"],
      ["normal", "Normal"],
      ["relaxed", "Relaxed"],
    ],
  },
  face: {
    label: "Reading face",
    options: [
      ["serif", "Serif"],
      ["sans", "Sans-serif"],
    ],
  },
};

// What each control shows when the cookie doesn't set it: what the stylesheet does then.
const DEFAULTS: Record<SettingName, string> = {
  theme: "",
  size: "m",
  leading: "normal",
  face: "serif",
};

/**
 * A label and select for each setting, the current value selected. Ids start with
 * `idPrefix`, so the reader bar's controls never clash with the page's own.
 */
export const settingsControls = (idPrefix: string, settings: Settings) =>
  SETTING_NAMES.map((name) => {
    const { label, options } = CONTROLS[name];
    const current = settings[name] ?? DEFAULTS[name];
    const id = `${idPrefix}${name}`;
    const choices = options
      .map(
        ([value, text]) =>
          `<option value="${escapeHtml(value)}"${value === current ? " selected" : ""}>${escapeHtml(text)}</option>`,
      )
      .join("");
    return `<label for="${id}">${escapeHtml(label)}</label>
<select id="${id}" name="${name}">${choices}</select>`;
  }).join("\n");

/** The settings page: the form, posting back here, with `next` to return to. */
const settingsPage = (
  settings: Settings,
  next: string,
  nonce: string,
  warnings: { off: boolean } | null,
) =>
  layout(
    "Reader settings",
    `<form class="reader-settings" method="post" action="${SETTINGS_PATH}">
${settingsControls("settings-", settings)}
${warnings ? warningsControl(warnings.off) : ""}<input type="hidden" name="next" value="${escapeHtml(next)}">
<button type="submit">Save settings</button>
</form>
${next === SETTINGS_PATH ? "" : `<p><a href="${escapeHtml(next)}">Back</a></p>`}`,
    settingsScriptTag(nonce),
  );

/**
 * Where saving goes back to: `next`, reduced to a same-site path. This page when there
 * is none, since the reader came here directly, and when `next` was refused, so the
 * reader lands on a page that shows the flash.
 */
const returnTarget = (next: string | null | undefined) => {
  if (!next) return SETTINGS_PATH;
  const safe = safeNext(next);
  return safe === "/" && next !== "/" ? SETTINGS_PATH : safe;
};

/**
 * The settings script, for a page's head, deferred. It carries the page's nonce, which
 * `'strict-dynamic'` trusts wherever the file is served from (ARCHITECTURE, Reading).
 * A page that streams for long puts it `async` straight after the reader bar instead,
 * so it runs once the bar is parsed rather than after the whole page.
 */
export const settingsScriptTag = (nonce: string, load: "defer" | "async" = "defer") =>
  `<script src="${SETTINGS_SCRIPT_PATH}" nonce="${escapeHtml(nonce)}" ${load}></script>`;

/**
 * The reader's settings in a reader bar: the link to this page, coming back to
 * `returnTo`, and the controls as a form the settings script shows. Without
 * JavaScript the form stays hidden and the link is all there is. The same for every
 * reader: the script selects the reader's values from <html>'s attributes.
 */
export const barSettings = (returnTo: string) =>
  `<a href="${SETTINGS_PATH}?next=${escapeHtml(encodeURIComponent(returnTo))}">Reader settings</a>
<form class="reader-settings" method="post" action="${SETTINGS_PATH}" aria-label="Reader settings" hidden>
${settingsControls("bar-", {})}
<input type="hidden" name="next" value="${escapeHtml(returnTo)}">
</form>`;

/** `GET /settings/reader`: the form, showing the reader's current settings. */
export const showSettings = (c: SettingsContext) =>
  c.html(
    settingsPage(
      parseSettings(getCookie(c, SETTINGS_COOKIE)),
      returnTarget(c.req.query("next")),
      c.get("nonce"),
      c.var.session ? { off: c.var.session.user.warningsOff === true } : null,
    ),
  );

/**
 * `POST /settings/reader`: the origin check before the body, as on the sign-in forms;
 * then each submitted setting that is in its list replaces the cookie's, an empty theme
 * ("Match my device") removes it, and any other value is ignored, the cookie's kept. A
 * 303 back to `returnTarget`, with the flash.
 */
export async function saveSettings(c: SettingsContext) {
  if (!isSameOrigin(c.req.raw.headers)) return c.html(forbiddenPage(), 403);
  const form = await readForm(c.req.raw);
  if (form === null) return c.body(null, 413);

  const settings = parseSettings(getCookie(c, SETTINGS_COOKIE));
  for (const name of SETTING_NAMES) {
    const value = form.get(name);
    if (isSettingValue(name, value)) setSetting(settings, name, value);
    // "Match my device": no theme.
    else if (name === "theme" && value === "") delete settings.theme;
  }

  // The warnings choice goes to the account, never the cookie, and only a signed-in
  // reader's post that carries it counts.
  const user = c.var.session?.user;
  const warnings = form.get(WARNINGS_FIELD);
  if (user && (warnings === "skip" || warnings === "show")) {
    const off = warnings === "skip";
    // Only a change writes; a save of the font size alone leaves the row be.
    if (off !== (user.warningsOff === true)) await setWarningsOff(c, user.id, off);
  }

  c.header("Set-Cookie", settingsCookie(settings), { append: true });
  c.header("Set-Cookie", flashCookie("settings-saved"), { append: true });
  c.header("Cache-Control", "no-store");
  return c.redirect(returnTarget(form.get("next")), 303);
}
