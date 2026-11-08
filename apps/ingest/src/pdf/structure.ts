// A PDF's text and links -> a work's fields and chapters, as plain text. Pure: it never sees the
// file, only what `parser.ts` read from it. Field names follow the printed labels, never fonts or
// colours, which each tool that made the PDF sets differently.
import {
  EpubError,
  parseStats,
  TAG_LABELS,
  resolveByline,
  type Author,
  type SeriesRef,
  type Stats,
  type TagField,
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

/** The review reason of a byline the reader isn't sure it read whole: its version is held. */
export const BYLINE_UNSURE = "byline_unsure";

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
const MAX_FIELD_CHARS = 64 * 1024;
const MAX_MARKS = 256;
const MAX_STATS_CHARS = 2 * 1024;
/** Lines from the top of the file the preface's checks read. */
const PREFACE_LINES = 200;

const trimmed = (line: TextLine) => line.text.trim();

const decodeName = (raw: string): string => {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
};

/**
 * A tag's name from its link: AO3's own escapes for characters a URL segment can't hold. AO3's
 * PDFs encode the link twice ("|" is %257C), so it's decoded twice; a name left with a lone "%"
 * after the first keeps it, as `decodeName` does.
 */
const decodeTag = (raw: string): string =>
  decodeName(decodeName(raw.replace(/\/works\/?$/, "").replace(/\+/g, " ")))
    .replace(/\*s\*/g, "/")
    .replace(/\*a\*/g, "&")
    .replace(/\*d\*/g, ".")
    .replace(/\*h\*/g, "#")
    .replace(/\*q\*/g, "?");

type Layout = ReturnType<typeof layoutOf>;

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
function paragraphsOf(lines: TextLine[], layout: Layout): string[] {
  const paragraphs: string[] = [];
  let current: string[] = [];
  const end = () => {
    if (current.length > 0) paragraphs.push(current.join(" "));
    current = [];
  };
  let previous: TextLine | undefined;
  for (const line of lines) {
    const text = trimmed(line);
    if (text === "" || NOTES_POINTER.test(text)) continue;
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

/** Where a chapter starts: its line, its title, and how many lines of heading to leave out. */
interface ChapterStart {
  at: number;
  title: string;
  skip: number;
}

/** Each chapter's start from the outline: the work's title, then one entry per chapter. */
function startsFromOutline(
  outline: PdfText["outline"],
  lines: TextLine[],
  posted: number,
): ChapterStart[] | null {
  if (outline.length !== posted + 1) return null;
  const starts: ChapterStart[] = [];
  let from = 0;
  for (const entry of outline.slice(1)) {
    const at = indexFrom(
      lines,
      from,
      lines.length,
      (l) => l.page > entry.page || (l.page === entry.page && l.y <= entry.y + 4),
    );
    if (at < 0) return null;
    const title = entry.title.trim();
    starts.push({ at, title, skip: trimmed(lines[at]!) === title ? 1 : 0 });
    from = at + 1;
  }
  return starts;
}

const CLOSING_LINE = "please drop by the archive";

/** The first line in `from` to `to` that passes `test`, or -1. */
function indexFrom(
  lines: TextLine[],
  from: number,
  to: number,
  test: (line: TextLine) => boolean,
): number {
  for (let i = from; i < to; i++) if (test(lines[i]!)) return i;
  return -1;
}

const labelAt = (lines: TextLine[], label: string, from: number, to: number) =>
  indexFrom(lines, from, to, (l) => trimmed(l) === label);

/** Each label's place, and what's printed under each. */
interface PrintedFields {
  marks: { mark: Mark; label: string }[];
  printed: Map<string, string>;
}

/** The labels in each range of lines, and what follows each up to the next or the range's end. */
function readFields(lines: TextLine[], ranges: [number, number][]): PrintedFields {
  const marks: PrintedFields["marks"] = [];
  const printed = new Map<string, string>();
  const add = (label: string, value: string) => {
    const so = printed.get(label) ?? "";
    // Bounded, so the patterns run on these later can't be made slow by a file of one long field.
    if (so.length < MAX_FIELD_CHARS) printed.set(label, `${so} ${value}`.slice(0, MAX_FIELD_CHARS));
  };
  for (const [from, to] of ranges) {
    let open: string | null = null;
    for (let i = from; i < to; i++) {
      const line = lines[i]!;
      const value = trimmed(line);
      let last = 0;
      for (const match of value.matchAll(LABELS)) {
        // A preface has a dozen. Bounded, since each tag's link looks through them.
        if (marks.length >= MAX_MARKS) break;
        if (open !== null) add(open, value.slice(last, match.index));
        open = match[1]!.toLowerCase();
        last = match.index + match[0].length;
        // Several labels can share a line: each one's place on it, in proportion to its characters.
        const x = line.x + ((line.right - line.x) * match.index) / Math.max(1, value.length);
        marks.push({ mark: { page: line.page, y: line.y, x }, label: open });
      }
      if (open !== null) add(open, value.slice(last));
    }
  }
  return { marks, printed };
}

function lastLabelBefore(marks: PrintedFields["marks"], at: Mark): string | undefined {
  for (let i = marks.length - 1; i >= 0; i--) {
    if (reads(marks[i]!.mark, at)) return marks[i]!.label;
  }
  return undefined;
}

/** Tags from links, each under the last label before it, deduped by URL; with none, from print. */
function readTags(
  links: PageLink[],
  { marks, printed }: PrintedFields,
  inFields: (link: PageLink) => boolean,
) {
  const tags: PdfWork["tags"] = {
    rating: [],
    warnings: [],
    categories: [],
    fandoms: [],
    relationships: [],
    characters: [],
    freeforms: [],
  };
  const tagLinks = links
    .flatMap((link) => {
      const at = linkMark(link);
      return TAG_URL.test(link.url) && inFields(link) ? [{ link, at }] : [];
    })
    .sort((a, b) => (reads(a.at, b.at) ? -1 : 1));
  const seen = new Set<string>();
  for (const { link, at } of tagLinks) {
    if (seen.has(link.url)) continue;
    seen.add(link.url);
    const label = lastLabelBefore(marks, at);
    const field = label === undefined ? undefined : TAG_LABELS.get(label);
    if (field) tags[field].push(decodeTag(TAG_URL.exec(link.url)![1]!));
  }
  if (tagLinks.length > 0) return { tags, fromPrint: false };
  // With no links a tag holding ", " can't be told apart from two tags, so it's flagged.
  for (const [label, value] of printed) {
    const field = TAG_LABELS.get(label);
    if (!field) continue;
    tags[field].push(
      ...value
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s !== ""),
    );
  }
  return { tags, fromPrint: Object.values(tags).some((names) => names.length > 0) };
}

/**
 * Whether a link sits on this line: its middle within the line's band. Real ones sit 0.36 of the
 * size above the baseline, and the next line can be as near as 1.2 sizes under it, so the band is
 * no wider than this or the line below counts too.
 */
const onLine = (link: PageLink, line: TextLine): boolean => {
  if (link.page !== line.page) return false;
  const above = linkMark(link).y - line.y;
  return above >= -0.25 * line.size && above <= 0.75 * line.size;
};

/**
 * About how wide a character prints, in ems, as Helvetica and Times set it: enough to tell a run of
 * narrow letters from capitals, which spacing every character alike gets wrong by whole letters.
 */
function charWidth(code: number): number {
  const c = String.fromCharCode(code);
  if (code === 0x20) return 0.28;
  if ("ijlI.,:;'!|".includes(c)) return 0.25;
  if ("frt()-".includes(c)) return 0.33;
  if ("mwMW@".includes(c)) return 0.85;
  if (c >= "A" && c <= "Z") return 0.68;
  return 0.52;
}

/** A byline line's characters looked at, at most: enough for any real one. */
const MAX_BYLINE_LINE = 1024;

/**
 * Each UTF-16 unit of a line's text, up to `MAX_BYLINE_LINE`: whether a link covers it, placed by
 * its estimated width across the line.
 */
function coveredChars(line: TextLine, lineLinks: PageLink[]): boolean[] {
  const text = trimmed(line).slice(0, MAX_BYLINE_LINE);
  const widths = Array.from({ length: text.length }, (_, i) => charWidth(text.charCodeAt(i)));
  const total = widths.reduce((a, b) => a + b, 0) || 1;
  const scale = (line.right - line.x) / total;
  const spans = lineLinks.slice(0, 64).map((l) => [(l.rect[0] ?? 0) - 1, (l.rect[2] ?? 0) + 1]);
  let at = line.x;
  return widths.map((width) => {
    const middle = at + (width * scale) / 2;
    at += width * scale;
    return spans.some(([from, to]) => middle >= from! && middle <= to!);
  });
}

/** Whether a line's last word is mostly outside its links. */
function endsUnlinked(line: TextLine, lineLinks: PageLink[]): boolean {
  const text = trimmed(line).slice(0, MAX_BYLINE_LINE);
  const covered = coveredChars(line, lineLinks);
  const inWord = covered.slice(text.length - (/\S+$/.exec(text)?.[0].length ?? 0));
  return inWord.filter(Boolean).length * 2 < inWord.length;
}

const BYLINE_SEPARATOR = /\s*,\s*(?:and\s+)?|\s+and\s+/g;

/** A name in the byline, where it is, and whether links cover most of it. */
interface BylineName {
  name: string;
  from: number;
  to: number;
  linked: boolean;
}

/**
 * The names printed in a byline, split where AO3 lists them. A name counts as linked when links
 * cover most of it, not when it spells a link: a link can name a user where the print has a pseud,
 * and `Salt and Pepper` under one link is one name, though it splits as a list.
 */
function bylineNames(text: string, covered: boolean[]): BylineName[] {
  const names: BylineName[] = [];
  const add = (from: number, to: number) => {
    const name = text.slice(from, to).trim();
    if (name === "") return;
    let linked = 0;
    for (let i = from; i < to; i++) if (covered[i]) linked++;
    names.push({ name, from, to, linked: linked * 2 >= to - from });
  };
  let from = /^by\s+/.exec(text)?.[0].length ?? 0;
  for (const match of text.matchAll(BYLINE_SEPARATOR)) {
    add(from, match.index);
    from = match.index + match[0].length;
  }
  add(from, text.length);
  return names;
}

/** Whether two names are the same, whatever their case. */
const sameName = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * The byline: its first line and each one it wraps on to, close under it. It goes on when a line
 * ends on a separator, when one link runs across the two lines, or when a line with links ends on a
 * word without one and the next has a link. Links name its authors: by the pseud in the link, or the
 * name printed under it. A name printed with no link is named too, so the opt-out check reads it,
 * and flagged, since nothing says it isn't part of a name.
 */
function readByline(
  lines: TextLine[],
  links: PageLink[],
  bylineAt: number,
  prefaceEnd: number,
  layout: Layout,
) {
  const none: Author[] = [];
  // No byline names nobody, which `readWork` holds as unsure.
  if (bylineAt < 0) return { authors: none, ambiguous: false, unsure: false, end: prefaceEnd };
  // Only the marker alone: a name after it is a name, for the opt-out check to read.
  if (/^by\s+Anonymous$/i.test(trimmed(lines[bylineAt]!))) {
    const anonymous = [{ pseud: "Anonymous", user: null }];
    return { authors: anonymous, ambiguous: false, unsure: false, end: bylineAt + 1 };
  }
  const userLinks = links.filter((l) => USER_URL.test(l.url));
  const linksOn = (line: TextLine) => userLinks.filter((l) => onLine(l, line));
  const wraps = (above: TextLine, below: TextLine): boolean => {
    // A wrapped line sits as close under as any line of the text.
    if (above.page !== below.page || above.y - below.y > layout.pitch * 1.5) return false;
    if (/(?:,|\sand)$/i.test(trimmed(above))) return true;
    const fromAbove = linksOn(above);
    const fromBelow = linksOn(below);
    if (fromBelow.length === 0) return false;
    if (fromBelow.some((l) => fromAbove.some((a) => a.url === l.url))) return true;
    return fromAbove.length > 0 && endsUnlinked(above, fromAbove);
  };
  let end = bylineAt + 1;
  // No byline runs this long; a run that does is the text.
  while (end < prefaceEnd && end - bylineAt < 8 && wraps(lines[end - 1]!, lines[end]!)) end++;
  // Whether a name may go on past what was read: the byline ends its page, or the run stopped at
  // its cap, or the line close under the last has an author's link, or starts with a word the
  // last line had no room for. Each is held, not read further (operator's ruling, 2026-11-07).
  const last = lines[end - 1]!;
  const below = end < prefaceEnd ? lines[end] : undefined;
  const close =
    below !== undefined && below.page === last.page && last.y - below.y <= layout.pitch * 1.5;
  const endsPage = lines[end] !== undefined && lines[end]!.page !== last.page;
  const cut =
    endsPage ||
    (close &&
      ((end - bylineAt >= 8 && wraps(last, below)) ||
        linksOn(below).length > 0 ||
        noRoomFor(last, below, layout)));

  let byline = "";
  let covered: boolean[] = [];
  const placed: { link: PageLink; from: number; to: number }[] = [];
  for (let i = bylineAt; i < end; i++) {
    const line = lines[i]!;
    const lineLinks = linksOn(line);
    if (byline !== "") {
      byline += " ";
      covered.push(false);
    }
    const offset = byline.length;
    const lineCovered = coveredChars(line, lineLinks);
    byline += trimmed(line).slice(0, MAX_BYLINE_LINE);
    covered = covered.concat(lineCovered);
    // Where each link sits in the byline's text: what it covers on this line.
    for (const link of lineLinks.slice(0, 64)) {
      const only = coveredChars(line, [link]);
      const first = only.indexOf(true);
      if (first >= 0)
        placed.push({ link, from: offset + first, to: offset + only.lastIndexOf(true) + 1 });
    }
  }
  const names = bylineNames(byline, covered);
  const authors: Author[] = [];
  const add = (author: Author) => {
    if (!authors.some((a) => sameName(a.pseud, author.pseud) && a.user === author.user)) {
      authors.push(author);
    }
  };
  for (const { link, from, to } of placed) {
    const user = decodeName(USER_URL.exec(link.url)![1]!);
    const pseud = /\/pseuds\/([^/?#]+)/.exec(link.url)?.[1];
    if (pseud !== undefined) {
      add({ pseud: decodeName(pseud), user });
      continue;
    }
    // No pseud in the link: the name printed under it, as AO3 prints a pseud and its login, with
    // the login, which the opt-out check reads too.
    const under = names.find((n) => n.linked && n.from < to && n.to > from)?.name;
    const withLogin = under === undefined ? null : /^(.+?)\s*\(([^()]+)\)$/.exec(under);
    const printed = withLogin !== null && sameName(withLogin[2]!, user) ? withLogin[1]! : under;
    add({ pseud: printed ?? user, user });
  }
  // A name under a link that wrapped on to the next line is that link's, though split by a space.
  const unlinked = names.filter(
    (n) =>
      !n.linked &&
      !authors.some((a) => sameName(n.name, a.pseud) || sameName(n.name, `${a.pseud} (${a.user})`)),
  );
  return {
    authors: [...authors, ...unlinked.map((n): Author => ({ pseud: n.name, user: null }))],
    // Names with no links at all split as a list; beside links, one is a guess too.
    ambiguous: authors.length > 0 ? unlinked.length > 0 : unlinked.length > 1,
    // A name with no link may be part of one, or not a name at all.
    unsure: cut || unlinked.length > 0,
    end,
  };
}

/**
 * Whether the first word of `below` may not have fitted at the end of `above`, by estimated
 * widths: the line was full, and `below` may go on with it. Its room is counted both across the
 * text's measure and up to the margin from where the line ends, and the least is taken, since a
 * line can be indented or centred; a measure that can't be read leaves no room at all.
 */
function noRoomFor(above: TextLine, below: TextLine, layout: Layout): boolean {
  const measure = layout.right - layout.left;
  if (!(measure > 0)) return true;
  const word = /^\S+/.exec(trimmed(below))?.[0].slice(0, MAX_BYLINE_LINE) ?? "";
  let ems = charWidth(0x20);
  for (let i = 0; i < word.length; i++) ems += charWidth(word.charCodeAt(i));
  const room = Math.min(measure - (above.right - above.x), layout.right - above.right);
  return ems * above.size > room;
}

/** The series the preface prints, with their IDs from its links, in order. */
function readSeries(
  text: string,
  links: PageLink[],
  inFields: (link: PageLink) => boolean,
): SeriesRef[] {
  const ids = [
    ...new Set(links.filter(inFields).flatMap((l) => SERIES_URL.exec(l.url)?.[1] ?? [])),
  ];
  return [...text.matchAll(SERIES_PART)].map((match, i) => ({
    name: match[2]!.trim(),
    part: Number(match[1]),
    ao3SeriesId: ids[i] ?? null,
  }));
}

/**
 * The end of the chapters' text, and the end notes after it. Each mark is an exact line, and the
 * last of its kind, since a work's text can hold any of them and the afterword comes after it all.
 */
function readEnd(lines: TextLine[], from: number, layout: Layout) {
  const last = (test: (text: string) => boolean): number => {
    for (let i = lines.length - 1; i >= from; i--) if (test(trimmed(lines[i]!))) return i;
    return -1;
  };
  const closing = last((text) => text.toLowerCase().startsWith(CLOSING_LINE));
  const stop = closing < 0 ? lines.length : closing;
  // The heading says so only by what's under it: End Notes, the works inspired by this one, or the
  // closing line at most a line on. A chapter can have the word as its text, and the notes under
  // the heading can too, so the first that passes is the heading.
  let afterword = -1;
  for (let i = from; i < lines.length && afterword < 0; i++) {
    if (trimmed(lines[i]!) !== "Afterword") continue;
    const under = lines[i + 1] === undefined ? "" : trimmed(lines[i + 1]!);
    if (
      under === "End Notes" ||
      under.startsWith("Works inspired by this one") ||
      (closing > i && closing - i <= 2)
    ) {
      afterword = i;
    }
  }
  // A label in the text stays in the text. The real one is under the heading when there is one, and
  // otherwise before the closing line, which can't be told from one in the text just above it.
  const lastNotes = last((text) => text === "End Notes");
  const firstNotes =
    afterword >= 0
      ? indexFrom(lines, afterword + 1, lines.length, (l) => trimmed(l) === "End Notes")
      : -1;
  const notesAt = afterword >= 0 ? firstNotes : closing > lastNotes ? lastNotes : -1;
  const starts = [afterword, notesAt, closing].filter((at) => at >= 0);
  const bodyEnd = starts.length > 0 ? Math.min(...starts) : lines.length;
  const endNotes = notesAt < 0 ? [] : paragraphsOf(lines.slice(notesAt + 1, stop), layout);
  return { bodyEnd, endNotes };
}

/** Lines a browser's print repeats on most pages, with their page numbers and dates aside. */
function withoutRunningLines(lines: TextLine[]): TextLine[] {
  const pages = lines.at(-1)?.page ?? 0;
  const keyOf = (line: TextLine) => trimmed(line).replace(/[\d/:,]+/g, "#");
  const seen = new Map<string, number>();
  const edge = new Set<TextLine>();
  lines.forEach((line, i) => {
    if (lines[i - 1]?.page !== line.page || lines[i + 1]?.page !== line.page) edge.add(line);
  });
  for (const line of edge) seen.set(keyOf(line), (seen.get(keyOf(line)) ?? 0) + 1);
  // A chapter that starts each page isn't one, however many there are.
  const running = (line: TextLine) =>
    /^file:\/\//i.test(trimmed(line)) ||
    (!CHAPTER_HEADING.test(trimmed(line)) &&
      pages >= 3 &&
      (seen.get(keyOf(line)) ?? 0) >= Math.max(3, pages * 0.3));
  return lines.filter((line) => !edge.has(line) || !running(line));
}

/** The first line of the title that ends just before the byline: large print wraps. */
function titleStart(lines: TextLine[], bylineAt: number, layout: Layout): number {
  let at = bylineAt - 1;
  const size = lines[at]!.size;
  if (size <= layout.bodySize * 1.1) return at;
  while (at > 0 && Math.abs(lines[at - 1]!.size - size) < 0.5) at--;
  return at;
}

/** Where a run of field lines ends: the last line with a label or a tag's link, a gap of 2 allowed. */
function fieldsEnd(lines: TextLine[], links: PageLink[], from: number, to: number): number {
  const tagged = (l: TextLine) => links.some((link) => TAG_URL.test(link.url) && onLine(link, l));
  let end = from;
  for (let i = from; i < to && i - end <= 2; i++) {
    LABELS.lastIndex = 0;
    if (LABELS.test(trimmed(lines[i]!)) || tagged(lines[i]!)) end = i + 1;
  }
  return end;
}

/**
 * The byline among the lines up to `to`: the first with an author's link, or the marker alone; else
 * the first that follows large print, as a title is set; else the first. A title can start "by" too.
 */
function findByline(lines: TextLine[], links: PageLink[], to: number, layout: Layout): number {
  const isByline = (l: TextLine) => /^by\s/.test(trimmed(l));
  const linked = indexFrom(
    lines,
    0,
    to,
    (l) =>
      isByline(l) &&
      (/^by\s+Anonymous$/i.test(trimmed(l)) ||
        links.some((link) => USER_URL.test(link.url) && onLine(link, l))),
  );
  if (linked >= 0) return linked;
  for (let i = 1; i < to; i++) {
    if (isByline(lines[i]!) && lines[i - 1]!.size > layout.bodySize * 1.1) return i;
  }
  return indexFrom(lines, 0, to, isByline);
}

/** Reads the work's fields and chapters, or refuses the file with a rejection code. */
export function readWork(text: PdfText): PdfWork {
  const { links } = text;
  const posted = POSTED.exec(
    text.lines.slice(0, PREFACE_LINES).map(trimmed).join("").replace(/\s+/g, ""),
  );
  if (posted === null) throw new EpubError("not_ao3", "No printed Posted originally line");
  const ao3WorkId = posted[1]!;
  const reviewReasons = ["from_pdf"];
  const lines = withoutRunningLines(text.lines);
  const layout = layoutOf(lines);
  const headings = lines.flatMap((l, i) =>
    CHAPTER_HEADING.test(trimmed(l)) && l.size > layout.bodySize * 1.1 ? [i] : [],
  );

  // How far the preface can run: its labels, or the first heading, or a fixed number of lines.
  const reach = Math.min(headings[0] ?? lines.length, PREFACE_LINES);
  const summaryLabel = labelAt(lines, "Summary", 0, reach);
  const notesLabel = labelAt(lines, "Notes", 0, reach);
  const labelled = [summaryLabel, notesLabel].filter((at) => at >= 0);
  const prefaceEnd = labelled.length > 0 ? Math.min(...labelled) : reach;

  const bylineAt = findByline(lines, links, prefaceEnd, layout);
  const titleAt = bylineAt > 0 ? titleStart(lines, bylineAt, layout) : -1;
  const title =
    titleAt >= 0 ? lines.slice(titleAt, bylineAt).map(trimmed).join(" ") : (text.infoTitle ?? "");
  if (title === "") reviewReasons.push("missing_title");
  const named = readByline(lines, links, bylineAt, prefaceEnd, layout);
  const bylineEnd = bylineAt < 0 ? 0 : named.end;

  // The fields come before the title or after the byline.
  const before =
    titleAt >= 0 ? titleAt : bylineAt >= 0 ? 0 : fieldsEnd(lines, links, 0, prefaceEnd);
  const beforeFields = readFields(lines, [[0, before]]);
  const after =
    beforeFields.marks.length > 0
      ? bylineEnd
      : labelled.length > 0
        ? prefaceEnd
        : fieldsEnd(lines, links, bylineEnd, prefaceEnd);
  const fields = readFields(lines, [
    [0, before],
    [bylineEnd, after],
  ]);
  const printedOf = (label: string) => fields.printed.get(label)?.trim() ?? null;
  // Where the fields end: the title, when they come before it.
  const fieldsStop = lines[beforeFields.marks.length > 0 ? before : after];
  // A link above that line: on the line itself, it belongs to what comes next.
  const inFields = (link: PageLink): boolean =>
    fieldsStop === undefined ||
    link.page < fieldsStop.page ||
    (link.page === fieldsStop.page && linkMark(link).y > fieldsStop.y + 0.75 * fieldsStop.size);
  // The printed line wraps, and a work's URL is on it or the next two.
  const postedAt = indexFrom(lines, 0, reach, (l) => /posted\s*originally/i.test(trimmed(l)));
  // The line, and the lines it wraps on to before its sentence ends.
  let postedEnd = postedAt + 1;
  while (
    postedAt >= 0 &&
    postedEnd < postedAt + 3 &&
    !trimmed(lines[postedEnd - 1]!).endsWith(".")
  ) {
    postedEnd++;
  }
  const onPosted = (link: PageLink): boolean =>
    postedAt >= 0 && lines.slice(postedAt, postedEnd).some((l) => onLine(link, l));
  // Any link in the fields or on the printed line: one in the text can name any work.
  const linkedWork = links
    .filter((l) => inFields(l) || onPosted(l))
    .map((l) => WORK_URL.exec(l.url)?.[1])
    .find((id) => id !== undefined && id !== ao3WorkId);
  if (linkedWork !== undefined) {
    reviewReasons.push(`work_id_mismatch: printed ${ao3WorkId}, link ${linkedWork}`);
  }
  const { tags, fromPrint } = readTags(links, fields, inFields);
  if (fromPrint) reviewReasons.push("tags_from_print");
  if (tags.rating.length === 0) reviewReasons.push("missing_rating");

  const byline = resolveByline(named.authors, named.ambiguous, []);
  reviewReasons.push(...byline.reviewReasons);
  // The version is held for a moderator (spec 12): an author the reader missed would go unchecked.
  if (named.unsure || byline.authors.length === 0) reviewReasons.push(BYLINE_UNSURE);

  const statsRaw: Record<string, string> = Object.create(null);
  const stats = parseStats((printedOf("stats") ?? "").slice(0, MAX_STATS_CHARS), statsRaw);
  const declared = stats.chapters.posted;

  // In a one-chapter work a heading in the text is the text's.
  const single = declared <= 1;
  const starts: ChapterStart[] | null = single
    ? null
    : headings.length === declared
      ? headings.map((at) => ({ at, title: trimmed(lines[at]!), skip: 1 }))
      : startsFromOutline(text.outline, lines, declared);
  const firstBody = starts?.[0]?.at ?? lines.length;

  const indented = (l: TextLine | undefined) => l !== undefined && l.x > layout.left + 2;
  /**
   * Where a Summary or Notes block ends. With a chapter to come, at the next label or that chapter.
   * In a one-chapter work nothing marks it, so it ends where its indent does, or at a page break.
   */
  const blockEnd = (from: number, next: number): number => {
    if (!single) return next > from ? next : firstBody;
    const to = next > from ? next : lines.length;
    if (indented(lines[from + 1])) {
      const out = indexFrom(lines, from + 1, to, (l) => !indented(l));
      return out < 0 ? to : out;
    }
    const page = lines[from]!.page;
    const broken = indexFrom(lines, from + 1, to, (l) => l.page !== page);
    return broken < 0 ? to : broken;
  };
  // In a one-chapter work a label counts only where the preface still is: right after what came
  // before it, not somewhere in the text.
  let body = Math.max(before, after, bylineEnd);
  let summaryAt = -1;
  let notesAt = -1;
  let summaryEnd = -1;
  let notesEnd = -1;
  if (single) {
    for (;;) {
      const line = lines[body];
      const label = line === undefined ? "" : trimmed(line);
      if (label === "Summary" && summaryAt < 0) {
        summaryAt = body;
        summaryEnd = blockEnd(body, labelAt(lines, "Notes", body, Math.min(lines.length, reach)));
        body = summaryEnd;
      } else if (label === "Notes" && notesAt < 0) {
        notesAt = body;
        notesEnd = blockEnd(body, -1);
        body = notesEnd;
      } else if (line !== undefined && NOTES_POINTER.test(label)) {
        body++;
      } else {
        break;
      }
    }
  } else {
    summaryAt = labelAt(lines, "Summary", 0, Math.min(firstBody, PREFACE_LINES));
    notesAt = labelAt(lines, "Notes", Math.max(summaryAt, 0), Math.min(firstBody, PREFACE_LINES));
    summaryEnd = summaryAt >= 0 ? blockEnd(summaryAt, notesAt) : -1;
    notesEnd = notesAt >= 0 ? blockEnd(notesAt, -1) : -1;
  }
  const summary =
    summaryAt >= 0 ? paragraphsOf(lines.slice(summaryAt + 1, summaryEnd), layout) : [];
  const notes = notesAt >= 0 ? paragraphsOf(lines.slice(notesAt + 1, notesEnd), layout) : [];

  const lastStart = starts?.at(-1)?.at ?? body;
  const { bodyEnd, endNotes } = readEnd(lines, lastStart, layout);

  let chapters: PdfWork["chapters"];
  if (starts !== null) {
    chapters = starts.map(({ at, title: name, skip }, k) => ({
      title: name,
      paragraphs: paragraphsOf(lines.slice(at + skip, starts[k + 1]?.at ?? bodyEnd), layout),
    }));
  } else if (single) {
    // A heading right where the text starts names the chapter, and isn't its text.
    const heading = headings[0] === body;
    chapters = [
      {
        title: heading ? trimmed(lines[body]!) : title,
        paragraphs: paragraphsOf(lines.slice(heading ? body + 1 : body, bodyEnd), layout),
      },
    ];
  } else {
    throw new EpubError("pdf_unreadable", "Chapters couldn't be told apart");
  }
  if (chapters.some((c) => c.paragraphs.length === 0)) {
    throw new EpubError("pdf_unreadable", "Chapters couldn't be told apart");
  }

  return {
    ao3WorkId,
    title,
    authors: byline.authors,
    tags,
    language: printedOf("language") || null,
    series: readSeries((printedOf("series") ?? "").slice(0, MAX_STATS_CHARS), links, inFields),
    stats,
    rawMeta: Object.fromEntries(Object.entries(statsRaw)),
    summary,
    notes,
    endNotes,
    chapters,
    reviewReasons,
  };
}
