import {
  boundedText,
  cleanText,
  find,
  findAll,
  findOutermost,
  hasClass,
  idOf,
  nextElementSibling,
  walk,
  type ElementNode,
} from "./dom";
import { splitNames } from "./byline";
import { collapseWhitespace, decodeEntities } from "./entities";
import type { Author, SeriesRef, Stats } from "./types";

// AO3 preface -> metadata. Fields are matched by label text, never by class:
// calibre renames classes. Only a few semantic hooks (ids, `byline`) survive.

interface ParsedByline {
  authors: Author[];
  bylineAmbiguous: boolean;
}

export interface Preface {
  workId: string | null;
  title: string | null;
  authors: Author[];
  /** The byline had no profile links and split into several names: the split is a guess. */
  bylineAmbiguous: boolean;
  rating: string | null;
  warnings: string[];
  categories: string[];
  fandoms: string[];
  relationships: string[];
  characters: string[];
  freeforms: string[];
  language: string | null;
  series: SeriesRef[];
  stats: Stats;
  summary: ElementNode | null;
  notes: ElementNode | null;
  endNotes: ElementNode | null;
  rawMeta: Record<string, string>;
}

const WORK_URL = /^https?:\/\/(?:www\.)?archiveofourown\.org\/works\/(\d+)(?:[/?#]|$)/i;

export function workIdFromUrl(url: string): string | null {
  return WORK_URL.exec(url.trim())?.[1] ?? null;
}

type TagField =
  | "rating"
  | "warnings"
  | "categories"
  | "fandoms"
  | "relationships"
  | "characters"
  | "freeforms";

// A Map, so a label such as "Constructor:" is not found on Object.prototype.
const TAG_LABELS = new Map<string, TagField>([
  ["rating", "rating"],
  ["ratings", "rating"],
  ["archive warning", "warnings"],
  ["archive warnings", "warnings"],
  ["category", "categories"],
  ["categories", "categories"],
  ["fandom", "fandoms"],
  ["fandoms", "fandoms"],
  ["relationship", "relationships"],
  ["relationships", "relationships"],
  ["character", "characters"],
  ["characters", "characters"],
  ["additional tag", "freeforms"],
  ["additional tags", "freeforms"],
]);

// Text caps for label predicates that run on every preface element.
const LABEL_CHARS = 64;
const LINE_CHARS = 2_000;

/** All outermost elements with this id, across the spine in order. */
export function regionsById(roots: readonly ElementNode[], id: string): ElementNode[] {
  return roots.flatMap((root) => findOutermost(root, (el) => idOf(el) === id));
}

function href(el: ElementNode): string {
  return decodeEntities(el.attrs["href"] ?? "").trim();
}

function tagList(dd: ElementNode): string[] {
  const links = findAll(dd, (el) => el.tag === "a");
  const names =
    links.length > 0
      ? links.map(cleanText)
      : cleanText(dd)
          .split(",")
          .map((s) => s.trim());
  return names.filter((s) => s !== "");
}

function parseSeries(dd: ElementNode): SeriesRef[] {
  const out: SeriesRef[] = [];
  let before = "";
  for (const node of dd.children) {
    if (node.type === "element" && node.tag === "a") {
      const part = /part\s+(\d+)\s+of\s*$/i.exec(collapseWhitespace(before));
      const id = /archiveofourown\.org\/series\/(\d+)/i.exec(href(node));
      out.push({
        name: cleanText(node),
        part: part ? Number(part[1]) : null,
        ao3SeriesId: id?.[1] ?? null,
      });
      before = "";
    } else {
      before += cleanText(node) + " ";
    }
  }
  if (out.length === 0 && cleanText(dd) !== "")
    out.push({ name: cleanText(dd), part: null, ao3SeriesId: null });
  return out;
}

function parseStats(text: string, rawMeta: Record<string, string>): Stats {
  const stats: Stats = {
    published: null,
    updated: null,
    completed: null,
    words: null,
    chapters: { posted: 1, total: 1 },
  };
  for (const [, key, value] of text.matchAll(/([A-Za-z][A-Za-z ]*?):\s*(\S+)/g)) {
    switch (key!.trim().toLowerCase()) {
      case "published":
        stats.published = value!;
        break;
      case "updated":
        stats.updated = value!;
        break;
      case "completed":
        stats.completed = value!;
        break;
      case "words": {
        const n = Number(value!.replace(/[,.\s]/g, ""));
        stats.words = Number.isFinite(n) ? n : null;
        break;
      }
      case "chapters": {
        const m = /^(\d+)\/(\d+|\?)$/.exec(value!);
        if (m)
          stats.chapters = {
            posted: Number(m[1]),
            total: m[2] === "?" ? null : Number(m[2]),
          };
        else rawMeta["Stats: Chapters"] = value!;
        break;
      }
      default:
        rawMeta[`Stats: ${key!.trim()}`] = value!;
    }
  }
  return stats;
}

function parseAuthors(prefaces: ElementNode[]): ParsedByline {
  let byline: ElementNode | null = null;
  for (const region of prefaces) {
    byline =
      find(region, (el) => hasClass(el, "byline")) ??
      find(
        region,
        (el) =>
          /^by\s/i.test(boundedText(el, LINE_CHARS) ?? "") &&
          find(el, (a) => a.tag === "a" && /\bauthor\b/.test(a.attrs["rel"] ?? "")) !== null,
      );
    if (byline) break;
  }
  if (!byline) return { authors: [], bylineAmbiguous: false };
  const links = findAll(
    byline,
    (el) =>
      el.tag === "a" && (/\bauthor\b/.test(el.attrs["rel"] ?? "") || /\/users\//.test(href(el))),
  );
  if (links.length === 0) {
    // e.g. "by Anonymous": names with no profile links.
    const names = splitNames(cleanText(byline).replace(/^by(?:\s+|$)/i, ""));
    return {
      authors: names.map((pseud) => ({ pseud, user: null })),
      bylineAmbiguous: names.length > 1,
    };
  }
  const authors = links.map((a) => {
    const m = /\/users\/([^/?#]+)/.exec(href(a));
    let user: string | null = null;
    if (m) {
      try {
        user = decodeURIComponent(m[1]!);
      } catch {
        user = m[1]!;
      }
    }
    let pseud = cleanText(a);
    // AO3 writes "pseud (user)" when they differ.
    if (user && pseud.endsWith(` (${user})`)) pseud = pseud.slice(0, -(user.length + 3));
    return { pseud, user };
  });
  return { authors, bylineAmbiguous: false };
}

/** The blockquote following a `<p>Summary</p>`-style label inside `scope`. */
function headedBlock(scope: readonly ElementNode[], label: string): ElementNode | null {
  const want = label.toLowerCase();
  for (const region of scope) {
    for (const heading of findAll(
      region,
      (el) => boundedText(el, LABEL_CHARS)?.toLowerCase() === want,
    )) {
      const block = nextElementSibling(heading);
      if (block?.tag === "blockquote") return block;
    }
  }
  return null;
}

// The line reads "Posted originally on the <a>Archive of Our Own</a> at <a>URL</a>".
const POSTED = /posted originally on the/i;
// Bounds the work on hostile input: matching text nodes tried, and elements
// looked at after each one.
const MAX_POSTED_MATCHES = 20;
const MAX_POSTED_SIBLINGS = 8;

/**
 * The work URL from the "Posted originally on the Archive of Our Own" line:
 * the first work link among the elements that follow the matching text node.
 * Anchored on the text node, so it works whatever element holds the line.
 */
function findWorkId(prefaces: ElementNode[]): string | null {
  let tried = 0;
  for (const region of prefaces) {
    // SAFETY: widens the initial null, so TS doesn't read it as null after the walk has run.
    let id = null as string | null;
    walk(region, (n) => {
      if (id !== null || tried >= MAX_POSTED_MATCHES) return false;
      if (n.type !== "text" || !n.parent || !POSTED.test(decodeEntities(n.raw))) return true;
      tried++;
      const siblings = n.parent.children;
      for (
        let i = siblings.indexOf(n) + 1, seen = 0;
        i < siblings.length && seen < MAX_POSTED_SIBLINGS;
        i++
      ) {
        const s = siblings[i]!;
        if (s.type !== "element") continue;
        seen++;
        for (const a of s.tag === "a" ? [s] : findAll(s, (el) => el.tag === "a")) {
          id = workIdFromUrl(href(a));
          if (id !== null) return false;
        }
      }
      return true;
    });
    if (id !== null) return id;
  }
  return null;
}

export function parsePreface(roots: readonly ElementNode[]): Preface {
  const prefaces = regionsById(roots, "preface");
  // No prototype: labels come from the file, and may be "__proto__".
  const rawMeta: Record<string, string> = Object.create(null);
  const tags: Record<TagField, string[]> = {
    rating: [],
    warnings: [],
    categories: [],
    fandoms: [],
    relationships: [],
    characters: [],
    freeforms: [],
  };
  let language: string | null = null;
  let series: SeriesRef[] = [];
  let stats: Stats | null = null;

  const dl = prefaces
    .map(
      (r) =>
        find(r, (el) => el.tag === "dl" && hasClass(el, "tags")) ??
        find(r, (el) => el.tag === "dl"),
    )
    .find(Boolean);
  if (dl) {
    let label: string | null = null;
    for (const node of dl.children) {
      if (node.type !== "element") continue;
      if (node.tag === "dt") {
        label = cleanText(node).replace(/\s*:\s*$/, "");
        continue;
      }
      if (node.tag !== "dd" || label === null) continue;
      const key = label.toLowerCase();
      const field = TAG_LABELS.get(key);
      if (field) tags[field].push(...tagList(node));
      else if (key === "language") language = cleanText(node) || null;
      else if (key === "series") series = series.concat(parseSeries(node));
      else if (key === "stats") stats = parseStats(cleanText(node), rawMeta);
      else
        rawMeta[label] =
          rawMeta[label] === undefined ? cleanText(node) : `${rawMeta[label]}, ${cleanText(node)}`;
    }
  }

  const h1 = prefaces.map((r) => find(r, (el) => el.tag === "h1")).find(Boolean);
  const endNoteScope = regionsById(roots, "endnotes");

  return {
    workId: findWorkId(prefaces),
    title: h1 ? cleanText(h1) || null : null,
    ...parseAuthors(prefaces),
    rating: tags.rating[0] ?? null,
    warnings: tags.warnings,
    categories: tags.categories,
    fandoms: tags.fandoms,
    relationships: tags.relationships,
    characters: tags.characters,
    freeforms: tags.freeforms,
    language,
    series,
    stats: stats ?? parseStats("", rawMeta),
    summary: headedBlock(prefaces, "Summary"),
    notes: headedBlock(prefaces, "Notes"),
    endNotes: headedBlock(
      endNoteScope.length ? endNoteScope : regionsById(roots, "afterword"),
      "End Notes",
    ),
    // A plain object for callers; fromEntries keeps "__proto__" as an own key.
    rawMeta: Object.fromEntries(Object.entries(rawMeta)),
  };
}
