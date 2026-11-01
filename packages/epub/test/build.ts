import { zipSync, strToU8, type Zippable } from "fflate";

// Builders for synthetic, AO3-shaped epubs. Structure only, no real fanwork text.
// No vitest or ../src imports: scripts/synthetic-fixtures.ts runs this under plain Node.

// A fixed entry time keeps the bytes the same on every run, so committed fixtures
// don't churn. Zip times are local: a local-time Date reads back the same in any zone.
const MTIME = new Date(2020, 0, 1);

/** Zips entries with an uncompressed `mimetype` first, as epubs require. */
export function zipEntries(
  entries: Record<string, string | Uint8Array>,
  mimetype: string | null = "application/epub+zip",
): Uint8Array {
  const z: Zippable = {};
  if (mimetype !== null) z["mimetype"] = [strToU8(mimetype), { level: 0 }];
  for (const [name, data] of Object.entries(entries))
    // oxlint-disable-next-line deslop/no-runtime-typeof -- tells the string | Uint8Array union apart, realm-safe
    z[name] = typeof data === "string" ? strToU8(data) : data;
  return zipSync(z, { mtime: MTIME });
}

const xhtml = (body: string) => `<?xml version='1.0' encoding='utf-8'?>
<html xmlns="http://www.w3.org/1999/xhtml" lang="en" xml:lang="en">
  <head><title>Synthetic</title><link rel="stylesheet" type="text/css" href="stylesheet.css"/></head>
  <body class="calibre">
${body}
  </body>
</html>`;

export interface SpineFile {
  name: string;
  body: string;
}

export interface Ao3Spec {
  /** null leaves the "Posted originally" line out. */
  workId?: number | null;
  title?: string;
  /** The byline's one pseud, also its user name: letters and digits only. */
  pseud?: string;
  stats?: string;
  /** Extra `<dt>/<dd>` markup appended to the tag list. */
  extraDl?: string;
  /** The `Language:` value. */
  language?: string;
  /** Inner markup of the byline `<div>`, after "by ". Replaces the pseud's link. */
  byline?: string;
  summary?: string;
  notes?: string;
  endNotes?: string;
  /** Chapter files, in spine order, after the preface file. */
  files?: SpineFile[];
  /** NCX entries for chapters, `src` relative to the OPF (URL-encoded). */
  navPoints?: { label: string; src: string }[];
  extraManifest?: { href: string; mediaType: string; data: string | Uint8Array }[];
  mimetype?: string | null;
}

export function ao3Epub(spec: Ao3Spec = {}): Uint8Array {
  const workId = spec.workId === undefined ? 1000001 : spec.workId;
  const title = spec.title ?? "Synthetic Work";
  const pseud = spec.pseud ?? "someone";
  // It goes unescaped into a URL path, XHTML and the OPF.
  if (!/^[A-Za-z0-9]+$/.test(pseud)) throw new Error(`pseud must be letters and digits: ${pseud}`);
  const stats = spec.stats ?? "Published: 2020-01-02 Words: 12";
  const files = spec.files ?? [
    {
      name: "Synthetic_split_001.xhtml",
      body: `<div id="chapters" class="userstuff1"><h2 class="toc-heading" id="calibre_toc_3">${title}</h2>
<div class="userstuff2"><p class="calibre7">marker-only-chapter text.</p></div></div>`,
    },
  ];
  const navPoints = spec.navPoints ?? files.map((f) => ({ label: title, src: encodeURI(f.name) }));

  const posted =
    workId === null
      ? ""
      : `<p class="message"><b class="calibre2">${title}</b><br class="calibre1"/>
    Posted originally on the <a href="http://archiveofourown.org/">Archive of Our Own</a> at <a href="http://archiveofourown.org/works/${workId}">http://archiveofourown.org/works/${workId}</a>.</p>`;

  const preface = xhtml(`<div id="preface" class="calibre1">
  <h2 class="toc-heading" id="calibre_toc_2">Preface</h2>
  ${posted}
  <div class="calibre1"><dl class="tags">
    <dt class="calibre3">Rating:</dt><dd class="calibre4"><a href="http://archiveofourown.org/tags/General%20Audiences">General Audiences</a></dd>
    <dt class="calibre3">Archive Warning:</dt><dd class="calibre4"><a href="http://archiveofourown.org/tags/x">No Archive Warnings Apply</a></dd>
    <dt class="calibre3">Fandom:</dt><dd class="calibre4"><a href="http://archiveofourown.org/tags/y">Test Fandom</a></dd>
    <dt class="calibre3">Additional Tags:</dt><dd class="calibre4"><a href="http://archiveofourown.org/tags/a">Tag A</a>, <a href="http://archiveofourown.org/tags/b">Tag &amp; B</a></dd>
    <dt class="calibre3">Language:</dt><dd class="calibre4">${spec.language ?? "English"}</dd>
    ${spec.extraDl ?? ""}
    <dt class="calibre3">Stats:</dt><dd class="calibre5">${stats}</dd>
  </dl></div>
  <div class="calibre1">
    <h1 class="calibre6">${title}</h1>
    <div class="byline">by ${spec.byline ?? `<a href="http://archiveofourown.org/users/${pseud}/pseuds/${pseud}" rel="author">${pseud}</a>`}</div>
    <p class="calibre7">Summary</p>
    <blockquote class="userstuff">${spec.summary ?? '<p class="calibre7">A synthetic summary.</p>'}</blockquote>
    <p class="calibre7">Notes</p>
    <blockquote class="userstuff">${spec.notes ?? '<p class="calibre7">Synthetic notes.</p>'}</blockquote>
    <div class="endnote-link">See the end of the work for more <a href="Synthetic_afterword.xhtml#endnotes">notes</a></div>
  </div>
</div>`);

  const afterword =
    xhtml(`<div id="afterword" class="calibre1"><h2 class="toc-heading">Afterword</h2>
  <div id="endnotes"><p class="calibre7">End Notes</p><blockquote class="userstuff">${spec.endNotes ?? "<p>Synthetic end notes.</p>"}</blockquote></div>
  <p class="message">Please <a href="http://archiveofourown.org/works/${workId}/comments/new">drop by the archive and comment</a> to let the author know if you enjoyed their work!</p>
</div>`);

  const spine = [
    "Synthetic_preface.xhtml",
    ...files.map((f) => f.name),
    "Synthetic_afterword.xhtml",
  ];
  const extras = spec.extraManifest ?? [];
  const manifest = [
    ...spine.map(
      (href, i) =>
        `<item id="html${i}" href="${encodeURI(href)}" media-type="application/xhtml+xml"/>`,
    ),
    ...extras.map((e, i) => `<item id="extra${i}" href="${e.href}" media-type="${e.mediaType}"/>`),
    `<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>`,
  ].join("\n    ");

  const opf = `<?xml version='1.0' encoding='utf-8'?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="uuid_id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">
    <dc:title>${title}</dc:title>
    <dc:language>en</dc:language>
    <dc:creator opf:role="aut">${pseud}</dc:creator>
    <dc:identifier id="uuid_id" opf:scheme="uuid">00000000-0000-4000-8000-000000000000</dc:identifier>
    <dc:publisher>Archive of Our Own</dc:publisher>
  </metadata>
  <manifest>
    ${manifest}
  </manifest>
  <spine toc="ncx">
    ${spine.map((_, i) => `<itemref idref="html${i}"/>`).join("\n    ")}
  </spine>
</package>`;

  const points = [
    { label: "Preface", src: "Synthetic_preface.xhtml" },
    ...navPoints,
    { label: "Afterword", src: "Synthetic_afterword.xhtml" },
  ];
  const ncx = `<?xml version='1.0' encoding='utf-8'?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <navMap>
    ${points.map((p, i) => `<navPoint id="np${i}" playOrder="${i + 1}"><navLabel><text>${p.label}</text></navLabel><content src="${p.src}"/></navPoint>`).join("\n    ")}
  </navMap>
</ncx>`;

  // oxlint-disable-next-line deslop/no-known-value-widening -- chapter and extra files are added by name below
  const entries: Record<string, string | Uint8Array> = {
    "META-INF/container.xml": `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`,
    "content.opf": opf,
    "toc.ncx": ncx,
    "stylesheet.css": ".calibre { display: block }",
    "Synthetic_preface.xhtml": preface,
    "Synthetic_afterword.xhtml": afterword,
  };
  for (const f of files) entries[f.name] = xhtml(f.body);
  for (const e of extras) entries[decodeURI(e.href)] = e.data;
  return zipEntries(entries, spec.mimetype === undefined ? "application/epub+zip" : spec.mimetype);
}
