import { expect } from "vitest";
import { BASE, fetchW } from "./helpers";

// A browser with JavaScript off, for the tests of what a reader without scripts can do:
// it reads the HTML the Worker returned, follows its links, fills in its forms from their
// own markup and submits them, keeping cookies and following redirects as a browser does.
// It reads markup with regular expressions: the pages are the Worker's own, written one
// way, and a regular expression that stops matching fails the test loudly.

const decode = (text: string) =>
  text
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");

/** The value of attribute `name` in the attribute text of a tag, or null when it has none. */
export function attr(attributes: string, name: string): string | null {
  const match = new RegExp(`(?:^|\\s)${name}(?:="([^"]*)"|='([^']*)'|(?=\\s|/?$))`, "i").exec(
    attributes,
  );
  if (match === null) return null;
  return decode(match[1] ?? match[2] ?? "");
}

export type Field = { name: string; value: string; type: string };

export type Form = {
  method: "get" | "post";
  /** The action as written, or the empty string when the form has none. */
  action: string;
  id: string | null;
  hidden: boolean;
  /** Every field a browser would send untouched, in order: no unchecked box or button. */
  fields: Field[];
  /** The form's inner markup. */
  html: string;
};

/** Every form in `html`, with the values its fields hold as served. */
export function forms(html: string): Form[] {
  return [...html.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/gi)].map(([, attributes, inner]) => {
    const fields: Field[] = [];
    for (const [, tag] of inner!.matchAll(/<input\b([^>]*)>/gi)) {
      const name = attr(tag!, "name");
      const type = (attr(tag!, "type") ?? "text").toLowerCase();
      if (name === null || ["submit", "button", "image", "reset", "file"].includes(type)) continue;
      if ((type === "radio" || type === "checkbox") && attr(tag!, "checked") === null) continue;
      fields.push({ name, value: attr(tag!, "value") ?? (type === "checkbox" ? "on" : ""), type });
    }
    for (const [, tag, options] of inner!.matchAll(/<select\b([^>]*)>([\s\S]*?)<\/select>/gi)) {
      const name = attr(tag!, "name");
      if (name === null) continue;
      const all = [...options!.matchAll(/<option\b([^>]*)>([\s\S]*?)<\/option>/gi)];
      const chosen = all.find(([, a]) => attr(a!, "selected") !== null) ?? all[0];
      if (chosen === undefined) continue;
      fields.push({
        name,
        value: attr(chosen[1]!, "value") ?? decode(chosen[2]!.trim()),
        type: "select",
      });
    }
    for (const [, tag, text] of inner!.matchAll(/<textarea\b([^>]*)>([\s\S]*?)<\/textarea>/gi)) {
      const name = attr(tag!, "name");
      if (name !== null) fields.push({ name, value: decode(text!), type: "textarea" });
    }
    return {
      method: (attr(attributes!, "method") ?? "get").toLowerCase() === "post" ? "post" : "get",
      action: attr(attributes!, "action") ?? "",
      id: attr(attributes!, "id"),
      hidden: attr(attributes!, "hidden") !== null,
      fields,
      html: inner!,
    };
  });
}

export type Link = { href: string; text: string };

/** Every link in `html`, with its visible text (tags stripped). */
export function links(html: string): Link[] {
  return [...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)].flatMap(([, attributes, inner]) => {
    const href = attr(attributes!, "href");
    return href === null ? [] : [{ href, text: decode(inner!.replace(/<[^>]*>/g, "").trim()) }];
  });
}

/** The attribute text of every `<script` tag in `html`. */
export const scriptTags = (html: string) =>
  [...html.matchAll(/<script\b([^>]*)>/gi)].map(([, attributes]) => attributes!);

/** `html` without its scripts, as a browser with JavaScript off sees it. */
export const withoutScripts = (html: string) =>
  html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");

/** The text of the first `<h1>`, tags stripped. */
export const h1Text = (html: string) =>
  decode(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(html)?.[1]?.replace(/<[^>]*>/g, "") ?? "");

/**
 * Asserts that each needle is in `html` and that they come in the order given: the order
 * a reader meets them with CSS off. `where` names the page in a failure.
 */
export function expectInOrder(html: string, needles: (string | RegExp)[], where = "") {
  let from = 0;
  let previous = "the start";
  for (const needle of needles) {
    const rest = html.slice(from);
    const found =
      typeof needle === "string" ? { at: rest.indexOf(needle), size: needle.length } : find(rest, needle);
    const label = String(needle);
    expect(found.at, `${where}: ${label} should come after ${previous}`).toBeGreaterThanOrEqual(0);
    from += found.at + found.size;
    previous = label;
  }
}

function find(text: string, pattern: RegExp) {
  const match = pattern.exec(text);
  return match === null ? { at: -1, size: 0 } : { at: match.index, size: match[0].length };
}

export type Page = {
  /** The final response, after any redirects. */
  res: Response;
  html: string;
  /** The path and query the page was served from. */
  path: string;
};

/** A browser with no JavaScript and its own cookie jar. */
export class NoJsBrowser {
  readonly cookies = new Map<string, string>();
  /** Every path requested, redirects included, in order. */
  readonly visited: string[] = [];

  /** Starts signed in with a session cookie from helpers' `signIn` (`name=value`). */
  withCookie(cookie: string) {
    this.keep(cookie);
    return this;
  }

  private keep(setCookie: string) {
    const [pair = ""] = setCookie.split(";");
    const eq = pair.indexOf("=");
    const name = pair.slice(0, eq);
    const value = pair.slice(eq + 1);
    if (/;\s*max-age=0/i.test(setCookie) || value === "") this.cookies.delete(name);
    else this.cookies.set(name, value);
  }

  private header() {
    return [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; ");
  }

  private async send(path: string, init: RequestInit = {}) {
    this.visited.push(path);
    const headers: Record<string, string> = { ...(init.headers as Record<string, string>) };
    if (this.cookies.size > 0) headers.cookie = this.header();
    const res = await fetchW(path, { ...init, headers });
    for (const setCookie of res.headers.getSetCookie()) this.keep(setCookie);
    return res;
  }

  /** Opens `path`, as a link or the address bar does, following up to 5 redirects. */
  async go(path: string): Promise<Page> {
    return this.settle(await this.send(path), path);
  }

  /** Follows a link found in a page: its href, resolved against the page it was in. */
  async click(from: Page, href: string): Promise<Page> {
    return this.go(resolve(from.path, href));
  }

  /**
   * Submits `form` as found in `from`: its own fields, with `fill` over them (a name
   * given sets that field, adding it when the form has none, as picking a radio or
   * ticking a box does).
   */
  async submit(from: Page, form: Form, fill: Record<string, string> = {}): Promise<Page> {
    const values = new Map(form.fields.map((f) => [f.name, f.value]));
    for (const [name, value] of Object.entries(fill)) values.set(name, value);
    const target = resolve(from.path, form.action === "" ? from.path : form.action);
    const body = new URLSearchParams([...values]).toString();
    if (form.method === "get") {
      const url = new URL(target, BASE);
      url.search = body;
      return this.go(url.pathname + url.search);
    }
    const res = await this.send(target, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: BASE,
        "sec-fetch-site": "same-origin",
      },
      body,
    });
    return this.settle(res, target);
  }

  private async settle(first: Response, firstPath: string): Promise<Page> {
    let res = first;
    let path = firstPath;
    for (let hops = 0; res.status >= 300 && res.status < 400 && hops < 5; hops++) {
      const location = res.headers.get("location");
      if (location === null) break;
      await res.body?.cancel();
      path = resolve(path, location);
      res = await this.send(path);
    }
    return { res, html: await res.text(), path };
  }
}

/** `href` resolved against the page at `base`, as a path and query on the site. */
function resolve(base: string, href: string) {
  const url = new URL(href, new URL(base, BASE));
  expect(url.origin, `${href} should stay on the site`).toBe(new URL(BASE).origin);
  return url.pathname + url.search;
}
