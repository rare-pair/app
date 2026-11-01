import { splitChapters, type SpineDoc } from "./chapters";
import { hasClass, nodeBudget, numberTree, parseHtml, type ElementNode } from "./dom";
import { collapseWhitespace } from "./entities";
import { EpubError } from "./errors";
import { collectImages, type ImageCandidate } from "./images";
import { dirOf, readPackage, resolveHref } from "./package";
import { parsePreface, workIdFromUrl } from "./preface";
import { serializeChildren, type SanitizeContext } from "./sanitize";
import type { Chapter, ParsedWork, ProcessOptions } from "./types";
import { LIMITS, READABLE, unzipEpub } from "./unzip";
import { countWords } from "./words";

/**
 * Parses an AO3-exported epub into metadata and sanitized chapter HTML.
 * The parse itself does no I/O and uses no clock or randomness, so the same
 * bytes give the same result. Throws `EpubError` with a rejection code. The
 * caller's `onImage` runs only after the parse has succeeded, and is the only
 * I/O: a retry runs it again.
 */
export async function processEpub(
  input: Uint8Array | ArrayBuffer,
  options: ProcessOptions = {},
): Promise<ParsedWork> {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.byteLength > LIMITS.maxInputBytes) {
    throw new EpubError("too_large", `File is larger than ${LIMITS.maxInputBytes} bytes`);
  }
  let result: { work: ParsedWork; images: ImageCandidate[] };
  try {
    result = await run(bytes, options);
  } catch (e) {
    if (e instanceof EpubError) throw e;
    throw new EpubError("parse_failed", e instanceof Error ? e.message : String(e), { cause: e });
  }
  // Outside the try: an error from the caller's callback is theirs, not a parse failure.
  for (const image of result.images) await options.onImage?.(image.ref, image.bytes);
  return result.work;
}

async function run(
  bytes: Uint8Array,
  options: ProcessOptions,
): Promise<{ work: ParsedWork; images: ImageCandidate[] }> {
  const files = unzipEpub(bytes);

  const mimetype = files.get("mimetype");
  if (!mimetype || new TextDecoder().decode(mimetype).trim() !== "application/epub+zip") {
    throw new EpubError("not_epub", "Missing or wrong mimetype entry");
  }

  // One node budget for the spine documents and the nav document of this epub.
  // (container.xml, the OPF and the NCX aren't charged to it.)
  const budget = nodeBudget();
  const pkg = readPackage(files, budget);
  const reviewReasons: string[] = [];
  // A missing spine item is held for review like a missing spine file: the
  // chapter count check alone would not notice if the rest still match Stats.
  for (const idref of pkg.unknownSpineRefs)
    reviewReasons.push(`unknown_spine_item: ${JSON.stringify(idref)}`);
  // unzipEpub reads entries by extension, before the manifest is known. Flag a
  // document or raster image it skipped, rather than lose it silently.
  for (const item of pkg.manifest.values()) {
    const wanted =
      item.mediaType === "application/xhtml+xml" ||
      item.mediaType === "text/html" ||
      (item.mediaType.startsWith("image/") && item.mediaType !== "image/svg+xml");
    if (wanted && !READABLE.test(item.path))
      reviewReasons.push(`unread_manifest_item: ${item.path}`);
  }

  const docs: SpineDoc[] = [];
  const parsed = new Set<string>();
  let next = 0;
  for (const item of pkg.spine) {
    if (parsed.has(item.path)) {
      reviewReasons.push(`duplicate_spine_item: ${item.path}`);
      continue;
    }
    parsed.add(item.path);
    const data = files.get(item.path);
    if (!data) {
      reviewReasons.push(`missing_spine_file: ${item.path}`);
      continue;
    }
    files.delete(item.path); // free the bytes once decoded: memory is the tight limit here
    const root = await parseHtml(new TextDecoder().decode(data), item.path, budget);
    next = numberTree(root, next);
    docs.push({ path: item.path, root });
  }

  const preface = parsePreface(docs.map((d) => d.root));
  const opf = pkg.metadata;

  // AO3-native exports only: the work URL must come from the preface's
  // "Posted originally" line. An AO3 URL only in the OPF (FanFicFare and
  // similar) is not enough; the OPF is a cross-check.
  const ao3WorkId = preface.workId;
  if (!ao3WorkId) throw new EpubError("not_ao3", "No AO3 preface with a work URL");
  const opfWorkId =
    [...opf.identifiers, ...opf.sources].map(workIdFromUrl).find((id) => id !== null) ?? null;
  if (opfWorkId && opfWorkId !== ao3WorkId) {
    reviewReasons.push(`work_id_mismatch: preface ${preface.workId}, OPF ${opfWorkId}`);
  }

  const opfTitle = opf.titles[0] ? collapseWhitespace(opf.titles[0]) : null;
  const title = preface.title ?? opfTitle ?? "";
  if (!title) reviewReasons.push("missing_title");
  else if (preface.title && opfTitle && preface.title !== opfTitle) {
    reviewReasons.push("title_mismatch: preface and OPF titles differ");
  }

  // Images: only manifest images that pass the checks, and only those the output uses.
  const candidates = await collectImages(files, pkg.manifest);
  files.clear(); // everything still needed is now parsed or held by `candidates`
  const used = new Map<string, ImageCandidate>();
  const imageBase =
    typeof options.imageBase === "function"
      ? options.imageBase(ao3WorkId)
      : (options.imageBase ?? "");
  // Before anything is serialized, so links in the summary and notes resolve too.
  const split = splitChapters(docs, pkg.navPoints);
  // The reader takes only digits with no leading zero, within Postgres's int4:
  // for any other ID a chapter link would be dead, so links stay text.
  const readerId = /^[1-9]\d{0,9}$/.test(ao3WorkId) && Number(ao3WorkId) <= 2_147_483_647;
  // `current` is the chapter being serialized, so a link to it stays plain
  // text; null outside chapters.
  const ctxFor = (current: number | null): SanitizeContext => ({
    resolveImage(src, fromFile) {
      const target = resolveHref(dirOf(fromFile), src);
      const candidate = target ? candidates.get(target.path) : undefined;
      if (!candidate) return null;
      if (!used.has(candidate.ref.key)) used.set(candidate.ref.key, candidate);
      return imageBase + candidate.ref.key;
    },
    resolveChapterLink(href, fromFile) {
      if (!readerId) return null;
      // Browsers drop tabs and newlines from a URL before reading it.
      const cleaned = href.replace(/[\t\n\r]/g, "");
      if (namesDirectory(cleaned)) return null;
      const target = resolveHref(dirOf(fromFile), cleaned);
      // `#` and an empty href name no target: only a file or an anchor does.
      if (!target || (target.path === "" && target.anchor === null)) return null;
      const n = split.chapterFor(target.path || fromFile, target.anchor);
      if (n === null || n === current) return null;
      return `/works/${ao3WorkId}/chapters/${n}`;
    },
    // "See the end of the work/chapter for more notes" links point inside the epub.
    skip: (el) => hasClass(el, "endnote-link"),
  });
  const ctx = ctxFor(null);
  const html = (el: ElementNode | null): string | null => {
    const out = el ? serializeChildren(el.children, ctx).trim() : "";
    return out === "" ? null : out;
  };

  let summaryHtml = html(preface.summary);
  if (summaryHtml === null && opf.descriptions[0]) {
    summaryHtml = html(await parseHtml(opf.descriptions[0], pkg.opfPath, budget));
  }
  const notesHtml = html(preface.notes);

  if (split.method === "files")
    reviewReasons.push("chapters_one_per_file: no usable table of contents or chapter headings");
  reviewReasons.push(...split.reviewReasons);
  const chapters: Chapter[] = [];
  for (const c of split.chapters) {
    const n = chapters.length + 1;
    const body = serializeChildren(c.nodes, ctxFor(n)).trim();
    chapters.push({ n, title: c.title, html: body, words: countWords(body) });
  }
  const endNotesHtml = html(preface.endNotes);

  // AO3 always sets a rating; without one the preface was not parsed (e.g. a
  // non-native file that only passed on an OPF work URL), and the reader's
  // content warning depends on it.
  if (preface.rating === null) reviewReasons.push("missing_rating");

  const stats = preface.stats;
  if (chapters.length !== stats.chapters.posted) {
    reviewReasons.push(
      `chapter_count_mismatch: parsed ${chapters.length}, Stats says ${stats.chapters.posted}`,
    );
  }

  const images = [...used.values()];

  const work: ParsedWork = {
    ao3WorkId,
    title,
    authors:
      preface.authors.length > 0
        ? preface.authors
        : opf.creators.map((pseud) => ({ pseud, user: null })),
    rating: preface.rating,
    warnings: preface.warnings,
    categories: preface.categories,
    fandoms: preface.fandoms,
    relationships: preface.relationships,
    characters: preface.characters,
    freeforms: preface.freeforms,
    language: preface.language,
    series: preface.series,
    stats,
    summaryHtml,
    notesHtml,
    endNotesHtml,
    chapters,
    images: images.map((i) => i.ref),
    rawMeta: preface.rawMeta,
    reviewReasons,
  };
  return { work, images };
}

/**
 * Whether a relative href's path ends in `/`, `.` or `..`, so it names a
 * directory, which a browser would not open as a chapter file.
 */
function namesDirectory(href: string): boolean {
  const path = href.split(/[?#]/, 1)[0]!;
  if (path === "") return false;
  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    return true; // resolveHref refuses it too
  }
  const last = decoded.slice(decoded.lastIndexOf("/") + 1);
  return last === "" || last === "." || last === "..";
}
