// The versioning decision (ARCHITECTURE, EPUB processor step 7): whether an upload of a known
// work replaces its current version, is held for review, or is a duplicate. Pure: it sees only
// the two versions' facts, never who uploaded either, so nobody gets special treatment.
import { normalizePseud, normalizeTagName, type HoldReason, type TagType } from "@archive/db";

/**
 * How alike two versions of a chapter must be, from 0 to 1, for the edit to count as small.
 * An operator-set default (the docs name no number): 90% similar.
 */
export const SIMILARITY_THRESHOLD = 0.9;

/** What the decision needs to know about one version of a work. */
export interface VersionFacts {
  /** The Updated, else Completed, else Published date as `YYYY-MM-DD`, or null if unknown. */
  date: string | null;
  /**
   * The posted chapters (their count is the chapter count). `text` is the chapter's sanitized
   * content: markup and whitespace differences don't matter, the words do.
   */
  chapters: { n: number; text: string }[];
  /** As stored: type and name as the file spells it. */
  tags: { type: TagType; name: string }[];
  authors: { pseud: string; user: string | null }[];
}

export type VersionDecision =
  | { outcome: "replace" }
  | { outcome: "duplicate"; reason: "not_newer" }
  | { outcome: "hold"; reason: HoldReason };

export interface VersionOptions {
  /** Chapter similarity at or above which an edit is small. Defaults to `SIMILARITY_THRESHOLD`. */
  threshold?: number;
}

/**
 * Newer and consistent replaces. Newer but changed (a shared chapter beyond a small edit, the
 * tags or the authors) is held. Not newer is a duplicate, whatever else differs.
 */
export function decideVersion(
  current: VersionFacts,
  upload: VersionFacts,
  options: VersionOptions = {},
): VersionDecision {
  const threshold = options.threshold ?? SIMILARITY_THRESHOLD;
  // NaN or a value outside 0..1 would pass every rewrite or hold every identical chapter.
  if (!(threshold >= 0 && threshold <= 1)) throw new RangeError("threshold must be from 0 to 1");
  if (!isNewer(current, upload)) return { outcome: "duplicate", reason: "not_newer" };
  if (!sharedChaptersAlike(current, upload, threshold)) {
    return { outcome: "hold", reason: "chapters_changed" };
  }
  if (!sameSet(tagKeys(current), tagKeys(upload))) {
    return { outcome: "hold", reason: "tags_changed" };
  }
  if (!sameSet(authorKeys(current), authorKeys(upload))) {
    return { outcome: "hold", reason: "authors_changed" };
  }
  return { outcome: "replace" };
}

/** More chapters, or a later date. Equal counts and equal dates are not newer; no date never is. */
function isNewer(current: VersionFacts, upload: VersionFacts): boolean {
  if (upload.chapters.length > current.chapters.length) return true;
  const from = validDate(current.date);
  const to = validDate(upload.date);
  return from !== null && to !== null && to > from;
}

function validDate(date: string | null): string | null {
  if (date === null || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const parsed = new Date(`${date}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(date) ? date : null;
}

/** The chapter numbers both versions have, each near-identical. */
function sharedChaptersAlike(
  current: VersionFacts,
  upload: VersionFacts,
  threshold: number,
): boolean {
  const before = new Map(current.chapters.map((c) => [c.n, c.text]));
  return upload.chapters.every((c) => {
    const text = before.get(c.n);
    return text === undefined || similarity(normalize(text), normalize(c.text)) >= threshold;
  });
}

/** Markup removed and runs of whitespace collapsed to one space. Case and punctuation count. */
function normalize(text: string): string {
  return text
    .replace(/<[^>]*>/g, " ")
    .replace(/\p{White_Space}+/gu, " ")
    .trim();
}

/**
 * 1 for identical text. Otherwise the Dice coefficient of the two texts' word pairs (a lone
 * word counts as its own pair): linear in the text's length, unlike an edit distance, which
 * a long chapter would make too slow. A typo costs two pairs; a rewrite costs nearly all.
 */
function similarity(a: string, b: string): number {
  if (a === b) return 1;
  const left = wordPairs(a);
  const right = wordPairs(b);
  const total = sum(left) + sum(right);
  if (total === 0) return 0;
  let common = 0;
  for (const [pair, count] of left) common += Math.min(count, right.get(pair) ?? 0);
  return (2 * common) / total;
}

function wordPairs(text: string): Map<string, number> {
  const words = text === "" ? [] : text.split(" ");
  const keys = words.length === 1 ? words : words.slice(1).map((w, i) => `${words[i]} ${w}`);
  const pairs = new Map<string, number>();
  for (const key of keys) pairs.set(key, (pairs.get(key) ?? 0) + 1);
  return pairs;
}

function sum(counts: Map<string, number>): number {
  let total = 0;
  for (const count of counts.values()) total += count;
  return total;
}

/** Every tag type, by normalized name (`name_norm`), so spelling and order don't matter. */
function tagKeys(facts: VersionFacts): Set<string> {
  return new Set(facts.tags.map((t) => `${t.type}\u0000${normalizeTagName(t.type, t.name)}`));
}

/** By normalized pseud, and the AO3 user where there is one. Byline order doesn't matter. */
function authorKeys(facts: VersionFacts): Set<string> {
  return new Set(
    facts.authors.map((a) => `${normalizePseud(a.pseud)}\u0000${normalizePseud(a.user ?? "")}`),
  );
}

function sameSet(a: Set<string>, b: Set<string>): boolean {
  return a.size === b.size && [...a].every((key) => b.has(key));
}
