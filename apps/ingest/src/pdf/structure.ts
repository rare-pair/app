// A PDF's text and links -> a work's fields and chapters, as plain text. Pure: it never sees the
// file, only what `parser.ts` read from it. Field names follow the printed labels, never fonts or
// colours, which each tool that made the PDF sets differently.
import {
  EpubError,
  parseStats,
  TAG_LABELS,
  resolveByline,
  splitNames,
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

/** A tag's name from its link: AO3's own escapes for characters a URL segment can't hold. */
const decodeTag = (raw: string): string =>
  decodeName(raw.replace(/\/works\/?$/, "").replace(/\+/g, " "))
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
function startsFromOutline(text: PdfText, posted: number): ChapterStart[] | null {
  if (text.outline.length !== posted + 1) return null;
  const { lines } = text;
  const starts: ChapterStart[] = [];
  let from = 0;
  for (const entry of text.outline.slice(1)) {
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

const CLOSING_LINE = "Please drop by the Archive";

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
function readTags(links: PageLink[], { marks, printed }: PrintedFields, prefaceMark: Mark) {
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
      return TAG_URL.test(link.url) && reads(at, prefaceMark) ? [{ link, at }] : [];
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

/** The byline: its first line and each one under it holding an author's link, and where it ends. */
function readByline(lines: TextLine[], links: PageLink[], bylineAt: number, prefaceEnd: number) {
  const authors: Author[] = [];
  if (bylineAt < 0) return { authors, ambiguous: false, end: prefaceEnd };
  const first = trimmed(lines[bylineAt]!);
  // Only the marker alone: a name after it is a name, for the opt-out check to read.
  if (/^by\s+Anonymous$/i.test(first)) {
    return { authors: [{ pseud: "Anonymous", user: null }], ambiguous: false, end: bylineAt + 1 };
  }
  const userLinks = links.filter((l) => USER_URL.test(l.url));
  let end = bylineAt + 1;
  for (let i = bylineAt; i < prefaceEnd; i++) {
    const line = lines[i]!;
    const onLine = userLinks.filter(
      (l) => l.page === line.page && Math.abs(linkMark(l).y - line.y) <= line.size,
    );
    if (onLine.length === 0) break;
    end = i + 1;
    for (const link of onLine) {
      const user = decodeName(USER_URL.exec(link.url)![1]!);
      const pseud = /\/pseuds\/([^/?#]+)/.exec(link.url)?.[1];
      const author = { pseud: pseud === undefined ? user : decodeName(pseud), user };
      if (!authors.some((a) => a.pseud === author.pseud && a.user === user)) authors.push(author);
    }
  }
  if (authors.length > 0) return { authors, ambiguous: false, end };
  // With no links, a line that ends on a separator goes on under it.
  let byline = first;
  while (end < prefaceEnd && /(?:,|\sand)$/i.test(byline)) {
    byline = `${byline} ${trimmed(lines[end]!)}`;
    end++;
  }
  const names = splitNames(byline.replace(/^by\s+/, ""));
  return {
    authors: names.map((pseud) => ({ pseud, user: null })),
    ambiguous: names.length > 1,
    end,
  };
}

/** The series the preface prints, with their IDs from its links, in order. */
function readSeries(text: string, links: PageLink[], prefaceMark: Mark): SeriesRef[] {
  const ids = [
    ...new Set(
      links
        .filter((l) => reads(linkMark(l), prefaceMark))
        .flatMap((l) => SERIES_URL.exec(l.url)?.[1] ?? []),
    ),
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
  const closing = last((text) => text.startsWith(CLOSING_LINE));
  const stop = closing < 0 ? lines.length : closing;
  const notesAt = last((text) => text === "End Notes");
  // The heading says so only with its contents under it: a chapter can have the word as its text.
  const lastAfterword = last((text) => text === "Afterword");
  const under = lastAfterword < 0 ? "" : trimmed(lines[lastAfterword + 1] ?? lines[lastAfterword]!);
  const afterword = under === "End Notes" || under.startsWith(CLOSING_LINE) ? lastAfterword : -1;
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
  const running = (line: TextLine) =>
    /^file:\/\//i.test(trimmed(line)) ||
    (pages >= 3 && (seen.get(keyOf(line)) ?? 0) >= Math.max(3, pages * 0.3));
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
  const tagged = (l: TextLine) =>
    links.some(
      (link) =>
        link.page === l.page &&
        TAG_URL.test(link.url) &&
        Math.abs(linkMark(link).y - l.y) <= l.size,
    );
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
        links.some(
          (link) =>
            link.page === l.page &&
            USER_URL.test(link.url) &&
            Math.abs(linkMark(link).y - l.y) <= l.size,
        )),
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
  const linkedWork = links.map((l) => WORK_URL.exec(l.url)?.[1]).find((id) => id !== undefined);
  if (linkedWork !== undefined && linkedWork !== ao3WorkId) {
    reviewReasons.push(`work_id_mismatch: printed ${ao3WorkId}, link ${linkedWork}`);
  }
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
  const named = readByline(lines, links, bylineAt, prefaceEnd);
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
  const fieldsStop = lines[Math.max(before, after)];
  const prefaceMark: Mark = fieldsStop
    ? { page: fieldsStop.page, y: fieldsStop.y, x: fieldsStop.x }
    : { page: Number.MAX_SAFE_INTEGER, y: 0, x: 0 };
  const { tags, fromPrint } = readTags(links, fields, prefaceMark);
  if (fromPrint) reviewReasons.push("tags_from_print");
  if (tags.rating.length === 0) reviewReasons.push("missing_rating");

  const byline = resolveByline(named.authors, named.ambiguous, []);
  reviewReasons.push(...byline.reviewReasons);

  const statsRaw: Record<string, string> = Object.create(null);
  const stats = parseStats((printedOf("stats") ?? "").slice(0, MAX_STATS_CHARS), statsRaw);
  const declared = stats.chapters.posted;

  // In a one-chapter work a heading in the text is the text's.
  const single = declared <= 1;
  const starts: ChapterStart[] | null = single
    ? null
    : headings.length === declared
      ? headings.map((at) => ({ at, title: trimmed(lines[at]!), skip: 1 }))
      : startsFromOutline(text, declared);
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
    series: readSeries((printedOf("series") ?? "").slice(0, MAX_STATS_CHARS), links, prefaceMark),
    stats,
    rawMeta: Object.fromEntries(Object.entries(statsRaw)),
    summary,
    notes,
    endNotes,
    chapters,
    reviewReasons,
  };
}
