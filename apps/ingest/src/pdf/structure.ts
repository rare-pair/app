// A PDF's text and links -> a work's fields and chapters, as plain text. Pure: it never sees the
// file, only what `parser.ts` read from it. Field names follow the printed labels, never fonts or
// colours, which each tool that made the PDF sets differently.
import {
  EpubError,
  parseStats,
  resolveByline,
  splitNames,
  type Author,
  type SeriesRef,
  type Stats,
} from "@archive/epub";

/** One line of print: its text and where it sits. `y` grows up the page, as PDF has it. */
export interface TextLine {
  page: number;
  x: number;
  y: number;
  size: number;
  /** Right edge of its text. */
  right: number;
  text: string;
}

export interface PageLink {
  page: number;
  url: string;
  rect: number[];
}

/** What the parser hands over. */
export interface PdfText {
  lines: TextLine[];
  links: PageLink[];
  infoTitle: string | null;
  /** The outline, flattened, each entry with the page and height it points at. */
  outline: { title: string; page: number; y: number }[];
}

/** A work as text, before any markup. Each paragraph is plain text. */
export interface PdfWork {
  ao3WorkId: string;
  title: string;
  authors: Author[];
  tags: Record<TagField, string[]>;
  language: string | null;
  series: SeriesRef[];
  stats: Stats;
  rawMeta: Record<string, string>;
  summary: string[];
  notes: string[];
  endNotes: string[];
  chapters: { title: string; paragraphs: string[] }[];
  reviewReasons: string[];
}

type TagField =
  | "rating"
  | "warnings"
  | "categories"
  | "fandoms"
  | "relationships"
  | "characters"
  | "freeforms";

// A Map, so a label such as "Constructor" is not found on Object.prototype.
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

const LABELS =
  /(Ratings?|Archive Warnings?|Categor(?:y|ies)|Fandoms?|Relationships?|Characters?|Additional Tags?|Language|Series|Stats):/g;

const AO3 = String.raw`^https?://(?:www\.|download\.)?archiveofourown\.org`;
const TAG_URL = new RegExp(`${AO3}/tags/([^?#]+)`, "i");
const USER_URL = new RegExp(`${AO3}/users/([^/?#]+)`, "i");
const SERIES_URL = new RegExp(`${AO3}/series/(\\d+)`, "i");
const WORK_URL = new RegExp(`${AO3}/works/(\\d+)`, "i");
const POSTED = /postedoriginallyonthe.{0,80}?archiveofourown\.org\/works\/(\d+)/i;
const CHAPTER_HEADING = /^Chapter \d+\b/;
const SERIES_PART = /Part\s+(\d+)\s+of\s+(.+?)(?=\s+Part\s+\d+\s+of\s|$)/g;
/** Lines from the top of the file the preface's checks read. */
const PREFACE_LINES = 200;

const trimmed = (line: TextLine) => line.text.trim();
const unreadable = (why: string) => new EpubError("pdf_unreadable", why);

function decodeTag(raw: string): string {
  let text = raw.replace(/\/works\/?$/, "").replace(/\+/g, " ");
  try {
    text = decodeURIComponent(text);
  } catch {
    // Not valid percent-encoding: the name stays as printed in the URL.
  }
  // AO3's own escapes for characters a URL segment can't hold.
  return text
    .replace(/\*s\*/g, "/")
    .replace(/\*a\*/g, "&")
    .replace(/\*d\*/g, ".")
    .replace(/\*h\*/g, "#")
    .replace(/\*q\*/g, "?");
}

const decodeName = (raw: string): string => {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
};

/** The size used most, the left edge used most, and the commonest line step on a page. */
function layoutOf(lines: TextLine[]) {
  const commonest = (values: number[]): number => {
    const counts = new Map<number, number>();
    let best = 0;
    let bestCount = 0;
    for (const value of values) {
      const count = (counts.get(value) ?? 0) + 1;
      counts.set(value, count);
      if (count > bestCount) {
        best = value;
        bestCount = count;
      }
    }
    return best;
  };
  const steps: number[] = [];
  for (let i = 1; i < lines.length; i++) {
    const step = Math.round(lines[i - 1]!.y - lines[i]!.y);
    if (lines[i]!.page === lines[i - 1]!.page && step > 0) steps.push(step);
  }
  return {
    bodySize: commonest(lines.map((l) => Math.round(l.size))),
    left: commonest(lines.map((l) => Math.round(l.x))),
    pitch: commonest(steps),
    /** Where most full lines end: nine in ten stop by here. */
    right: lines.map((l) => l.right).sort((a, b) => a - b)[Math.floor(lines.length * 0.9)] ?? 0,
  };
}

/** Whether a mark at (page, y, x) comes before another, in reading order. */
const reads = (a: Mark, b: Mark): boolean =>
  a.page < b.page ||
  (a.page === b.page && (a.y > b.y + 6 || (Math.abs(a.y - b.y) <= 6 && a.x <= b.x)));

interface Mark {
  page: number;
  y: number;
  x: number;
}

const linkMark = (link: PageLink): Mark => ({
  page: link.page,
  y: ((link.rect[1] ?? 0) + (link.rect[3] ?? 0)) / 2,
  x: link.rect[0] ?? 0,
});

/** The pointer AO3 prints to notes at the end, which an epub's reader drops too. */
const NOTES_POINTER = /^\(See the end of the (?:chapter|work) for (?:more )?notes\.?\)$/i;

/** A line with no letter or digit in it: a scene break. */
const isSceneBreak = (text: string) => text.length <= 24 && !/[\p{L}\p{N}]/u.test(text);

/**
 * Lines joined into paragraphs. A new one starts after a gap wider than the line step, or after a
 * line that stops short of the margin. A line of symbols alone is a scene break, in its own
 * paragraph. Not exact: on two files with an epub to compare, off by 5 to 19%. A print with no gap
 * between paragraphs needs the short line, or a whole chapter reads as a few walls of text.
 */
function paragraphsOf(lines: TextLine[], layout: ReturnType<typeof layoutOf>): string[] {
  const paragraphs: string[] = [];
  let current: string[] = [];
  const end = () => {
    if (current.length > 0) paragraphs.push(current.join(" "));
    current = [];
  };
  let previous: TextLine | undefined;
  for (const line of lines) {
    const text = trimmed(line);
    if (NOTES_POINTER.test(text)) continue;
    if (previous) {
      const samePage = previous.page === line.page;
      const wideGap = samePage && previous.y - line.y > layout.pitch * 1.5;
      const shortEnd = previous.right < layout.right - 30;
      if (wideGap || shortEnd) end();
    }
    if (isSceneBreak(text)) {
      end();
      paragraphs.push(text);
    } else {
      current.push(text);
    }
    previous = line;
  }
  end();
  return paragraphs;
}

/** Each chapter's first line and title from the outline: the work's title, then one per chapter. */
function chaptersFromOutline(
  text: PdfText,
  posted: number,
): { at: number; title: string; skip: number }[] | null {
  if (text.outline.length !== posted + 1) return null;
  const starts = [];
  let from = 0;
  for (const entry of text.outline.slice(1)) {
    const at = text.lines.findIndex(
      (l, i) => i >= from && (l.page > entry.page || (l.page === entry.page && l.y <= entry.y + 4)),
    );
    if (at < 0) return null;
    const title = entry.title.trim();
    starts.push({ at, title, skip: trimmed(text.lines[at]!) === title ? 1 : 0 });
    from = at + 1;
  }
  return starts;
}

const DECLARED_CHAPTERS = /Chapters:\s*(\d+)\//;

/** Reads the work's fields and chapters, or refuses the file with a rejection code. */
export function readWork(text: PdfText): PdfWork {
  const { lines, links } = text;
  const layout = layoutOf(lines);
  const top = lines.slice(0, PREFACE_LINES).map(trimmed);
  const posted = POSTED.exec(top.join("").replace(/\s+/g, ""));
  if (posted === null) throw new EpubError("not_ao3", "No printed Posted originally line");
  const ao3WorkId = posted[1]!;
  const reviewReasons = ["from_pdf"];
  const linkedWork = links.map((l) => WORK_URL.exec(l.url)?.[1]).find((id) => id !== undefined);
  if (linkedWork !== undefined && linkedWork !== ao3WorkId) {
    reviewReasons.push(`work_id_mismatch: printed ${ao3WorkId}, link ${linkedWork}`);
  }

  const isHeading = (l: TextLine) =>
    CHAPTER_HEADING.test(trimmed(l)) && l.size > layout.bodySize * 1.1;
  let headings = lines.flatMap((l, i) => (isHeading(l) ? [i] : []));
  const labelAt = (label: string, from: number, to: number) => {
    for (let i = from; i < to; i++) if (trimmed(lines[i]!) === label) return i;
    return -1;
  };
  // Where the preface's fields stop, whichever comes first.
  const firstLabel = (to: number) => {
    const summary = labelAt("Summary", 0, to);
    const notes = labelAt("Notes", 0, to);
    return summary >= 0 && (notes < 0 || summary < notes) ? summary : notes >= 0 ? notes : to;
  };
  const declared = Number(
    DECLARED_CHAPTERS.exec(top.slice(0, firstLabel(top.length)).join(" "))?.[1] ?? 1,
  );
  // In a one-chapter work a heading in the text is the text's, unless it's the only one.
  if (declared <= 1 && headings.length !== 1) headings = [];
  const firstHeading = headings[0] ?? lines.length;
  const outlineStarts = headings.length === declared ? null : chaptersFromOutline(text, declared);
  const firstBody = outlineStarts?.[0]?.at ?? firstHeading;
  const prefaceEnd = firstLabel(firstBody);

  const bylineAt = lines.slice(0, prefaceEnd).findIndex((l) => /^by\s/.test(trimmed(l)));
  const title = bylineAt > 0 ? trimmed(lines[bylineAt - 1]!) : (text.infoTitle ?? "");
  if (title === "") reviewReasons.push("missing_title");

  // Labels and what follows each. The title and byline may come before them or after, and end
  // what's printed under the last label before them.
  const marks: { mark: Mark; label: string }[] = [];
  const printed = new Map<string, string>();
  let openLabel: string | null = null;
  const addPrinted = (label: string, value: string) =>
    printed.set(label, `${printed.get(label) ?? ""} ${value}`);
  for (let i = 0; i < prefaceEnd; i++) {
    const line = lines[i]!;
    if (i === bylineAt || i === bylineAt - 1) {
      openLabel = null;
      continue;
    }
    const value = trimmed(line);
    let last = 0;
    for (const match of value.matchAll(LABELS)) {
      if (openLabel !== null) addPrinted(openLabel, value.slice(last, match.index));
      openLabel = match[1]!.toLowerCase();
      last = match.index + match[0].length;
      // Several labels can share a line: each one's place on it, in proportion to its characters.
      const x = line.x + ((line.right - line.x) * match.index) / Math.max(1, value.length);
      marks.push({ mark: { page: line.page, y: line.y, x }, label: openLabel });
    }
    if (openLabel !== null) addPrinted(openLabel, value.slice(last));
  }
  const printedOf = (label: string) => printed.get(label)?.trim() ?? null;

  const tags: Record<TagField, string[]> = {
    rating: [],
    warnings: [],
    categories: [],
    fandoms: [],
    relationships: [],
    characters: [],
    freeforms: [],
  };
  const endLine = lines[prefaceEnd];
  const prefaceMark: Mark = endLine
    ? { page: endLine.page, y: endLine.y, x: endLine.x }
    : { page: Number.MAX_SAFE_INTEGER, y: 0, x: 0 };
  const seen = new Set<string>();
  const tagLinks = links
    .filter((l) => TAG_URL.test(l.url) && reads(linkMark(l), prefaceMark))
    .sort((a, b) => (reads(linkMark(a), linkMark(b)) ? -1 : 1));
  for (const link of tagLinks) {
    if (seen.has(link.url)) continue;
    seen.add(link.url);
    const at = linkMark(link);
    const label = marks.filter((m) => reads(m.mark, at)).at(-1)?.label;
    const field = label === undefined ? undefined : TAG_LABELS.get(label);
    if (field) tags[field].push(decodeTag(TAG_URL.exec(link.url)![1]!));
  }
  if (tagLinks.length === 0) {
    // With no links a tag holding ", " can't be told apart from two tags, so it's flagged.
    for (const [label, value] of printed) {
      const field = TAG_LABELS.get(label);
      if (!field) continue;
      const names = value
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s !== "");
      tags[field].push(...names);
    }
    if (Object.values(tags).some((names) => names.length > 0))
      reviewReasons.push("tags_from_print");
  }
  if (tags.rating.length === 0) reviewReasons.push("missing_rating");

  // The byline: its first line and each one under it that holds an author's link.
  let authors: Author[] = [];
  let bylineEnd = bylineAt < 0 ? prefaceEnd : bylineAt + 1;
  let ambiguous = false;
  const bylineLine = bylineAt >= 0 ? lines[bylineAt]! : null;
  if (bylineLine && /^by\s+Anonymous\b/i.test(trimmed(bylineLine))) {
    authors = [{ pseud: "Anonymous", user: null }];
  } else if (bylineLine) {
    for (let i = bylineAt; i < prefaceEnd; i++) {
      const line = lines[i]!;
      const onLine = links.filter(
        (l) =>
          l.page === line.page &&
          USER_URL.test(l.url) &&
          Math.abs(linkMark(l).y - line.y) <= line.size,
      );
      if (onLine.length === 0) break;
      bylineEnd = i + 1;
      for (const link of onLine) {
        const user = decodeName(USER_URL.exec(link.url)![1]!);
        const pseud = /\/pseuds\/([^/?#]+)/.exec(link.url)?.[1];
        const author = { pseud: pseud === undefined ? user : decodeName(pseud), user };
        if (!authors.some((a) => a.pseud === author.pseud && a.user === user)) authors.push(author);
      }
    }
    if (authors.length === 0) {
      const names = splitNames(trimmed(bylineLine).replace(/^by\s+/, ""));
      authors = names.map((pseud) => ({ pseud, user: null }));
      ambiguous = names.length > 1;
    }
  }
  const byline = resolveByline(authors, ambiguous, []);
  reviewReasons.push(...byline.reviewReasons);

  const statsRaw: Record<string, string> = Object.create(null);
  const stats = parseStats(printedOf("stats") ?? "", statsRaw);

  const series: SeriesRef[] = [];
  const seriesLinks = [
    ...new Set(
      links
        .filter((l) => reads(linkMark(l), prefaceMark))
        .flatMap((l) => {
          const id = SERIES_URL.exec(l.url)?.[1];
          return id === undefined ? [] : [id];
        }),
    ),
  ];
  const seriesText = printedOf("series") ?? "";
  for (const match of seriesText.matchAll(SERIES_PART)) {
    series.push({
      name: match[2]!.trim(),
      part: Number(match[1]),
      ao3SeriesId: seriesLinks[series.length] ?? null,
    });
  }

  const single = declared <= 1 && headings.length === 0;
  const summaryAt = labelAt("Summary", 0, firstBody);
  const notesAt = labelAt("Notes", summaryAt < 0 ? 0 : summaryAt, firstBody);
  /**
   * Where a Summary or Notes block ends: at the next label, then the first chapter. A one-chapter
   * work has neither, so it ends where the block's indent does, or else at a page break.
   */
  const blockEnd = (from: number, next: number): number => {
    const limit = next > from ? next : firstBody;
    if (!single || next > from) return limit;
    const indented = (l: TextLine) => l.x > layout.left + 2;
    if (lines[from + 1] && indented(lines[from + 1]!)) {
      for (let i = from + 1; i < limit; i++) if (!indented(lines[i]!)) return i;
    }
    for (let i = from + 1; i < limit; i++) if (lines[i]!.page !== lines[from]!.page) return i;
    return limit;
  };
  const summaryEnd = summaryAt >= 0 ? blockEnd(summaryAt, notesAt) : -1;
  const notesEnd = notesAt >= 0 ? blockEnd(notesAt, -1) : -1;
  const summary =
    summaryAt >= 0 ? paragraphsOf(lines.slice(summaryAt + 1, summaryEnd), layout) : [];
  const notes = notesAt >= 0 ? paragraphsOf(lines.slice(notesAt + 1, notesEnd), layout) : [];

  const AFTERWORD = /^(?:Afterword|End Notes|Please drop by the)/;
  const lastStart =
    outlineStarts?.at(-1)?.at ?? headings.at(-1) ?? Math.max(bylineEnd, summaryEnd, notesEnd);
  let bodyEnd = lines.length;
  for (let i = lastStart; i < lines.length; i++) {
    if (AFTERWORD.test(trimmed(lines[i]!))) {
      bodyEnd = i;
      break;
    }
  }
  const endNotesAt = labelAt("End Notes", bodyEnd, lines.length);
  let endNotes: string[] = [];
  if (endNotesAt >= 0) {
    let stop = lines.length;
    for (let i = endNotesAt + 1; i < lines.length; i++) {
      if (trimmed(lines[i]!).startsWith("Please drop by the")) {
        stop = i;
        break;
      }
    }
    endNotes = paragraphsOf(lines.slice(endNotesAt + 1, stop), layout);
  }

  const couldntTell = () => unreadable("Chapters couldn't be told apart");
  let chapters: PdfWork["chapters"];
  if (single) {
    chapters = [{ title, paragraphs: paragraphsOf(lines.slice(lastStart, bodyEnd), layout) }];
  } else if (headings.length === declared) {
    chapters = headings.map((at, k) => ({
      title: trimmed(lines[at]!),
      paragraphs: paragraphsOf(lines.slice(at + 1, headings[k + 1] ?? bodyEnd), layout),
    }));
  } else if (outlineStarts !== null) {
    chapters = outlineStarts.map(({ at, title: name, skip }, k) => ({
      title: name,
      paragraphs: paragraphsOf(lines.slice(at + skip, outlineStarts[k + 1]?.at ?? bodyEnd), layout),
    }));
  } else {
    throw couldntTell();
  }
  if (chapters.some((c) => c.paragraphs.length === 0)) throw couldntTell();

  return {
    ao3WorkId,
    title,
    authors: byline.authors,
    tags,
    language: printedOf("language") || null,
    series,
    stats,
    rawMeta: Object.fromEntries(Object.entries(statsRaw)),
    summary,
    notes,
    endNotes,
    chapters,
    reviewReasons,
  };
}
