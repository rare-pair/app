// Synthetic PDFs for the tests, built by hand: no fic text, and nothing from a real file. Runs in
// Node and in workerd.
import { zlibSync } from "fflate";

const encoder = new TextEncoder();
const latin1 = (text: string) => Uint8Array.from(text, (c) => c.charCodeAt(0));

const join = (parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
};

/** One object's body: text, or bytes for a body that holds a binary stream. */
export type PdfBody = string | Uint8Array;

/** A stream object's body: `dict` is what goes in the dictionary, beside a correct `/Length`. */
export const stream = (dict: string, data: Uint8Array | string): Uint8Array => {
  const bytes = data instanceof Uint8Array ? data : latin1(data);
  return join([
    encoder.encode(`<< ${dict} /Length ${bytes.length} >>\nstream\n`),
    bytes,
    encoder.encode("\nendstream"),
  ]);
};

/** A stream of `data` deflated, as `/FlateDecode` holds it. */
export const flate = (data: Uint8Array | string, dict = ""): Uint8Array =>
  stream(
    `/Filter /FlateDecode ${dict}`,
    zlibSync(data instanceof Uint8Array ? data : latin1(data), { level: 6 }),
  );

export interface BuildOptions {
  /** More entries for the trailer: `/Encrypt 4 0 R`, say. */
  trailerExtra?: string;
  /** The trailer's `/Size`, when not the true one. */
  size?: number;
  /** The `startxref` offset, when not the true one. */
  startxref?: number;
}

/** The file for `bodies`, where `bodies[i]` is object `i + 1`, with a correct cross-reference table. */
export function buildPdf(bodies: PdfBody[], options: BuildOptions = {}): Uint8Array {
  const header = encoder.encode("%PDF-1.7\n");
  const parts: Uint8Array[] = [header];
  const offsets: number[] = [];
  let at = header.length;
  bodies.forEach((body, i) => {
    const object = join([
      encoder.encode(`${i + 1} 0 obj\n`),
      body instanceof Uint8Array ? body : encoder.encode(body),
      encoder.encode("\nendobj\n"),
    ]);
    offsets.push(at);
    parts.push(object);
    at += object.length;
  });
  const lines = ["xref", `0 ${bodies.length + 1}`, "0000000000 65535 f "];
  for (const offset of offsets) lines.push(`${String(offset).padStart(10, "0")} 00000 n `);
  const size = options.size ?? bodies.length + 1;
  const tail =
    `${lines.join("\n")}\ntrailer\n<< /Size ${size} /Root 1 0 R ${options.trailerExtra ?? ""} >>\n` +
    `startxref\n${options.startxref ?? at}\n%%EOF\n`;
  parts.push(encoder.encode(tail));
  return join(parts);
}

/** One line of text on a laid-out page. */
export interface PdfLine {
  text: string;
  /** Font size. Default 11. */
  size?: number;
  /** Left edge. Default 72. */
  x?: number;
  /** A link annotation over the line's text. */
  url?: string;
  /** Link annotations over parts of the line, by character. */
  links?: { url: string; at: number; length: number }[];
  /** Empty points above the line, on top of the line pitch. Default 0. */
  gap?: number;
  /** Starts a new page. */
  newPage?: boolean;
}

const PAGE_TOP = 720;
const PAGE_BOTTOM = 72;
const PITCH = 14;

const escapePdf = (text: string) => text.replace(/[\\()]/g, (c) => `\\${c}`);

/** A file laying `lines` out top to bottom on as many pages as they take. */
export function layoutPdf(
  lines: PdfLine[],
  options: {
    /** Each page draws a photo: an image XObject beside the text. */
    image?: boolean;
    outline?: { title: string; line: number }[];
    /** The outline's destinations name a page that isn't there. */
    brokenOutline?: boolean;
    info?: string;
  } = {},
): Uint8Array {
  const pages: { content: string[]; links: string[] }[] = [{ content: [], links: [] }];
  const placed = new Map<number, { page: number; y: number }>();
  let y = PAGE_TOP;
  lines.forEach((line, index) => {
    const size = line.size ?? 11;
    y -= line.gap ?? 0;
    if (line.newPage || y < PAGE_BOTTOM) {
      pages.push({ content: [], links: [] });
      y = PAGE_TOP;
    }
    const page = pages.at(-1)!;
    const x = line.x ?? 72;
    page.content.push(`BT /F1 ${size} Tf ${x} ${y} Td (${escapePdf(line.text)}) Tj ET`);
    if (line.url !== undefined) {
      const right = x + line.text.length * size * 0.5;
      page.links.push(
        `<< /Type /Annot /Subtype /Link /Rect [${x} ${y - 2} ${right} ${y + size}] ` +
          `/A << /S /URI /URI (${escapePdf(line.url)}) >> >>`,
      );
    }
    for (const link of line.links ?? []) {
      const left = x + link.at * size * 0.5;
      const right = left + link.length * size * 0.5;
      page.links.push(
        `<< /Type /Annot /Subtype /Link /Rect [${left} ${y - 2} ${right} ${y + size}] ` +
          `/A << /S /URI /URI (${escapePdf(link.url)}) >> >>`,
      );
    }
    placed.set(index, { page: pages.length - 1, y });
    y -= size > 11 ? size * 1.3 : PITCH;
  });
  const bodies: PdfBody[] = [
    "",
    "",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    options.info === undefined ? "null" : `<< /Title (${escapePdf(options.info)}) >>`,
  ];
  const imageAt = bodies.length + 1;
  if (options.image) {
    bodies.push(
      stream(
        "/Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /DCTDecode",
        Uint8Array.of(0xff, 0xd8, 0xff, 0xd9),
      ),
    );
  }
  const resources = options.image ? `/XObject << /Im ${imageAt} 0 R >>` : "";
  const kids: string[] = [];
  const pageRefs: number[] = [];
  for (const page of pages) {
    const pageNumber = bodies.length + 1;
    kids.push(`${pageNumber} 0 R`);
    pageRefs.push(pageNumber);
    bodies.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
        `/Resources << /Font << /F1 3 0 R >> ${resources} >> /Contents ${pageNumber + 1} 0 R ` +
        `/Annots [${page.links.join(" ")}] >>`,
    );
    bodies.push(flate(`${options.image ? "q /Im Do Q\n" : ""}${page.content.join("\n")}`));
  }
  bodies[1] = `<< /Type /Pages /Count ${pages.length} /Kids [${kids.join(" ")}] >>`;
  let outlines = "";
  if (options.outline !== undefined) {
    const root = bodies.length + 1;
    const first = root + 1;
    const count = options.outline.length;
    bodies.push(
      `<< /Type /Outlines /First ${first} 0 R /Last ${first + count - 1} 0 R /Count ${count} >>`,
    );
    options.outline.forEach((entry, i) => {
      const at = placed.get(entry.line)!;
      const siblings =
        (i > 0 ? `/Prev ${first + i - 1} 0 R ` : "") +
        (i < count - 1 ? `/Next ${first + i + 1} 0 R ` : "");
      bodies.push(
        `<< /Title (${escapePdf(entry.title)}) /Parent ${root} 0 R ${siblings}` +
          `/Dest [${options.brokenOutline ? 99999 : pageRefs[at.page]} 0 R /XYZ 0 ${at.y + 12} 0] >>`,
      );
    });
    outlines = `/Outlines ${root} 0 R`;
  }
  bodies[0] = `<< /Type /Catalog /Pages 2 0 R ${outlines} >>`;
  return buildPdf(bodies, { trailerExtra: options.info === undefined ? "" : "/Info 4 0 R" });
}

const AO3 = "https://archiveofourown.org";

export interface Ao3PdfOptions {
  workId: number;
  /** The work ID the printed line names, when not `workId`. */
  printedWorkId?: number;
  /** Leave out the "Posted originally" line. */
  noPostedLine?: boolean;
  /** A link to `workId` somewhere: on the printed line, unless `noPostedLine`. */
  linkWorkId?: number | null;
  title?: string;
  /** Pseud and AO3 user of each author. Default one. */
  authors?: { pseud: string; user: string }[];
  /** The byline is the anonymous marker. */
  anonymous?: boolean;
  /** Tags as links, or printed with no links. Default links. */
  tagLinks?: boolean;
  tags?: Partial<Record<TagLabel, string[]>>;
  /** The Stats line, or null for none. */
  stats?: string | null;
  summary?: string[];
  notes?: string[];
  /** Each chapter: an optional heading and its paragraphs. */
  chapters?: { heading?: string; paragraphs: string[] }[];
  endNotes?: string[];
  /** A link to a `/users/` page after the byline, in the summary. */
  strayUserLink?: boolean;
  /** Heading size. Default 16. */
  headingSize?: number;
  /** Chapter starts on the outline instead of big headings, as wkhtmltopdf's output is. */
  outlineChapters?: boolean;
}

type TagLabel =
  | "Rating"
  | "Archive Warning"
  | "Category"
  | "Fandom"
  | "Relationship"
  | "Character"
  | "Additional Tags";

const DEFAULT_TAGS: Record<TagLabel, string[]> = {
  Rating: ["Teen And Up Audiences"],
  "Archive Warning": ["No Archive Warnings Apply"],
  Category: ["Gen"],
  Fandom: ["Synthetic Fandom"],
  Relationship: ["Person A/Person B"],
  Character: ["Person A", "Person B"],
  "Additional Tags": ["Filler Tag, With A Comma", "Plain Tag"],
};

const FILLER = (n: number) => `Filler paragraph ${n} of plain synthetic words for the layout.`;

/** A synthetic PDF laid out as AO3's own download prints a work. No fic text. */
export function ao3Pdf(options: Ao3PdfOptions): Uint8Array {
  const {
    workId,
    title = `Synthetic work ${workId}`,
    authors = [{ pseud: "Synthetic Author", user: "synthetic_author" }],
    tagLinks = true,
    tags = DEFAULT_TAGS,
    summary = ["A synthetic summary."],
    notes = [],
    endNotes = [],
    headingSize = 16,
  } = options;
  const chapters = options.chapters ?? [{ paragraphs: [FILLER(1), FILLER(2)] }];
  const posted = chapters.length;
  const stats =
    options.stats === undefined
      ? `Published: 2020-01-01 Updated: 2020-02-01 Words: 100 Chapters: ${posted}/${posted}`
      : options.stats;
  const lines: PdfLine[] = [];
  const printed = options.printedWorkId ?? workId;
  const url = `${AO3}/works/${printed}`;
  if (!options.noPostedLine) {
    const link = options.linkWorkId === undefined ? workId : options.linkWorkId;
    const text = `Posted originally on the Archive of Our Own at ${url}.`;
    lines.push(link === null ? { text } : { text, url: `${AO3}/works/${link}` });
  } else if (options.linkWorkId !== undefined && options.linkWorkId !== null) {
    lines.push({ text: "A link to the work", url: `${AO3}/works/${options.linkWorkId}` });
  }
  for (const [label, names] of Object.entries(tags)) {
    if (tagLinks) {
      lines.push({ text: `${label}:` });
      for (const name of names) {
        lines.push({ text: name, url: `${AO3}/tags/${encodeURIComponent(name)}` });
      }
    } else {
      lines.push({ text: `${label}: ${names.join(", ")}` });
    }
  }
  lines.push({ text: "Language: English" });
  if (stats !== null) lines.push({ text: `Stats: ${stats}` });
  lines.push({ text: title, size: 18, gap: 10 });
  if (options.anonymous) {
    lines.push({ text: "by Anonymous" });
  } else {
    for (const [i, a] of authors.entries()) {
      lines.push({
        text: `${i === 0 ? "by " : ""}${a.pseud}`,
        url: `${AO3}/users/${a.user}/pseuds/${encodeURIComponent(a.pseud)}`,
      });
    }
  }
  const quoted = (text: string[]) => text.map((t, i) => ({ text: t, x: 90, gap: i === 0 ? 0 : 8 }));
  if (summary.length > 0) {
    lines.push({ text: "Summary", gap: 8 });
    lines.push(...quoted(summary));
    if (options.strayUserLink) {
      lines.push({ text: "A friend's page", x: 90, url: `${AO3}/users/some_friend` });
    }
  }
  if (notes.length > 0) {
    lines.push({ text: "Notes", gap: 8 });
    lines.push(...quoted(notes));
  }
  const outline: { title: string; line: number }[] = [{ title, line: 0 }];
  for (const [i, chapter] of chapters.entries()) {
    const heading = chapter.heading ?? (posted > 1 ? `Chapter ${i + 1}` : undefined);
    const first = lines.length;
    if (heading !== undefined) {
      lines.push(
        options.outlineChapters
          ? { text: heading, newPage: true }
          : { text: heading, size: headingSize, newPage: true },
      );
      if (options.outlineChapters) outline.push({ title: heading, line: first });
    } else if (i === 0) {
      lines.push({ text: chapter.paragraphs[0] ?? "", newPage: true });
    }
    const rest =
      heading === undefined && i === 0 ? chapter.paragraphs.slice(1) : chapter.paragraphs;
    lines.push(
      ...rest.map((text, p) => ({ text, gap: p === 0 && heading !== undefined ? 0 : 10 })),
    );
  }
  if (endNotes.length > 0) {
    lines.push({ text: "Afterword", size: 14, newPage: true });
    lines.push({ text: "End Notes", gap: 8 });
    lines.push(...quoted(endNotes));
  }
  lines.push({
    text: "Please drop by the Archive and comment to let the creator know if you enjoyed their work!",
    gap: 12,
  });
  return layoutPdf(lines, options.outlineChapters ? { info: title, outline } : { info: title });
}

/** A file of `count` empty pages. */
export function pagesPdf(count: number): Uint8Array {
  const pages = Array.from({ length: count }, (_, i) => i + 3);
  return buildPdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Count ${count} /Kids [${pages.map((n) => `${n} 0 R`).join(" ")}] >>`,
    ...pages.map(() => "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>"),
  ]);
}

/** A catalog, a page tree and one page whose contents are object 4, `content`. */
export const onePage = (content: PdfBody, options: BuildOptions = {}): Uint8Array =>
  buildPdf(
    [
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Count 1 /Kids [3 0 R] >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>",
      content,
    ],
    options,
  );
