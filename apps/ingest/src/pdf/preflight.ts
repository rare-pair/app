import { EpubError } from "@archive/epub";
import { Inflate } from "fflate";

const MiB = 1024 * 1024;

export const PDF_LIMITS = {
  /** Bytes all of a file's streams may inflate to. */
  maxInflatedBytes: 128 * MiB,
  /** A `/Contents` array's most entries. */
  maxContentsEntries: 8,
  /** Bytes one stream may inflate to, and one page's `/Contents` together. */
  maxStreamInflatedBytes: 16 * MiB,
  /** Objects a file may hold, by its trailer and by what it really has. The largest sample has 8,561. */
  maxObjects: 100_000,
  /** Pages a file may have: at the samples' 230 to 554 words a page, about 1M words. */
  maxPages: 5_000,
} as const;

// Compressed bytes fed to the inflater at a time. Deflate expands at most about 1032:1, so one
// push makes at most about 4 MiB before the budget is checked. A stored block, the one thing
// that holds input back unread, is at most 64 KiB, so a push never copies more than that twice.
const PUSH_BYTES = 4 * 1024;

const unreadable = (why: string) => new EpubError("pdf_unreadable", why);

const bytesOf = (word: string) => Array.from(word, (c) => c.charCodeAt(0));
const STREAM = bytesOf("stream");
const END = bytesOf("end");
const OBJ = bytesOf("obj");
const TRAILER = bytesOf("trailer");
const XREF = bytesOf("xref");
const STARTXREF = bytesOf("startxref");
const START = bytesOf("start");

const matches = (bytes: Uint8Array, at: number, word: number[]): boolean =>
  at >= 0 && word.every((b, i) => bytes[at + i] === b);

/** PDF's whitespace: NUL, tab, line feed, form feed, carriage return, space. */
const isSpace = (b: number | undefined): boolean =>
  b === 0 || b === 9 || b === 10 || b === 12 || b === 13 || b === 32;

const isDigit = (b: number | undefined): boolean => b !== undefined && b >= 0x30 && b <= 0x39;

const isLetter = (b: number | undefined): boolean =>
  b !== undefined && ((b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a));

/** A character that ends a name or a keyword: whitespace or a delimiter. */
const endsToken = (b: number | undefined): boolean =>
  b === undefined ||
  isSpace(b) ||
  b === 0x28 ||
  b === 0x29 ||
  b === 0x3c ||
  b === 0x3e ||
  b === 0x5b ||
  b === 0x5d ||
  b === 0x7b ||
  b === 0x7d ||
  b === 0x2f ||
  b === 0x25;

const hexValue = (b: number | undefined): number => {
  if (b === undefined) return -1;
  if (b >= 0x30 && b <= 0x39) return b - 0x30;
  if (b >= 0x41 && b <= 0x46) return b - 0x41 + 10;
  if (b >= 0x61 && b <= 0x66) return b - 0x61 + 10;
  return -1;
};

/** A direct value of a dictionary's top level: all the checks below look at. */
type Value =
  | { kind: "name"; name: string }
  | { kind: "number"; value: number }
  | { kind: "list"; items: Value[] }
  | { kind: "dict"; dict: Dict }
  | { kind: "other" };

/** A dictionary's top-level entries, a repeated key keeping every value, and where it ended. */
interface Dict {
  entries: Map<string, Value[]>;
  end: number;
}

/**
 * Reads PDF tokens as pdf.js's lexer does: comments, strings with nested brackets and escapes,
 * hex strings, names with `#xx` escapes. Bounded by `work`, a budget of bytes read that survives
 * from one dictionary to the next, so a file of overlapping `obj<<` can't make it quadratic.
 */
class Reader {
  at = 0;

  constructor(
    private readonly bytes: Uint8Array,
    private readonly work: { left: number },
  ) {}

  private spend(from: number): void {
    this.work.left -= this.at - from;
    if (this.work.left < 0) throw unreadable("Too much to read in dictionaries");
  }

  skipSpace(): void {
    const from = this.at;
    const { bytes } = this;
    for (;;) {
      const b = bytes[this.at];
      if (isSpace(b)) {
        this.at++;
      } else if (b === 0x25) {
        while (this.at < bytes.length && bytes[this.at] !== 10 && bytes[this.at] !== 13) this.at++;
      } else {
        break;
      }
    }
    this.spend(from);
  }

  private name(): Value {
    const from = this.at;
    const { bytes } = this;
    this.at++;
    let name = "";
    while (!endsToken(bytes[this.at])) {
      let b = bytes[this.at]!;
      // A malformed `#` stays as it is, as in pdf.js.
      if (b === 0x23 && hexValue(bytes[this.at + 1]) >= 0 && hexValue(bytes[this.at + 2]) >= 0) {
        b = hexValue(bytes[this.at + 1]) * 16 + hexValue(bytes[this.at + 2]);
        this.at += 2;
      }
      name += String.fromCharCode(b);
      this.at++;
    }
    this.spend(from);
    return { kind: "name", name };
  }

  private string(): void {
    const from = this.at;
    const { bytes } = this;
    let depth = 0;
    while (this.at < bytes.length) {
      const b = bytes[this.at++];
      if (b === 0x5c) this.at++;
      else if (b === 0x28) depth++;
      else if (b === 0x29 && --depth === 0) break;
    }
    this.spend(from);
  }

  private hexString(): void {
    const from = this.at;
    while (this.at < this.bytes.length && this.bytes[this.at] !== 0x3e) this.at++;
    this.at++;
    this.spend(from);
  }

  /** A number, a keyword or a reference's part. */
  private word(): Value {
    const from = this.at;
    const { bytes } = this;
    // A delimiter no value starts with, such as a stray `)`: one byte, so the read moves on.
    if (endsToken(bytes[this.at])) this.at++;
    else while (!endsToken(bytes[this.at])) this.at++;
    let digits = from < this.at;
    let value = 0;
    for (let i = from; i < this.at && digits; i++) {
      digits = isDigit(bytes[i]);
      value = value * 10 + (bytes[i]! - 0x30);
    }
    this.spend(from);
    return digits ? { kind: "number", value } : { kind: "other" };
  }

  /** One value, read past whatever it holds. Null at the end of the file. */
  value(): Value | null {
    this.skipSpace();
    const { bytes } = this;
    const b = bytes[this.at];
    if (b === undefined) return null;
    if (b === 0x2f) return this.name();
    if (b === 0x28) {
      this.string();
      return { kind: "other" };
    }
    if (b === 0x3c && bytes[this.at + 1] === 0x3c) {
      const dict = this.dict();
      return dict === null ? null : { kind: "dict", dict };
    }
    if (b === 0x3c) {
      this.hexString();
      return { kind: "other" };
    }
    if (b === 0x5b) return this.list();
    return this.word();
  }

  private list(): Value | null {
    this.at++;
    const items: Value[] = [];
    for (;;) {
      this.skipSpace();
      if (this.at >= this.bytes.length) return null;
      if (this.bytes[this.at] === 0x5d) {
        this.at++;
        return { kind: "list", items };
      }
      const item = this.value();
      if (item === null) return null;
      items.push(item);
    }
  }

  /** The dictionary at `at`, which must start `<<`. Null when the file ends inside it. */
  dict(): Dict | null {
    this.at += 2;
    const entries = new Map<string, Value[]>();
    const { bytes } = this;
    for (;;) {
      this.skipSpace();
      if (this.at >= bytes.length) return null;
      if (bytes[this.at] === 0x3e && bytes[this.at + 1] === 0x3e) {
        this.at += 2;
        return { entries, end: this.at };
      }
      // A key must be a name. pdf.js skips anything else, as this does.
      const key = this.value();
      if (key === null) return null;
      if (key.kind !== "name") continue;
      this.skipSpace();
      if (bytes[this.at] === 0x3e && bytes[this.at + 1] === 0x3e) continue;
      const value = this.value();
      if (value === null) return null;
      // A reference is three values; its later two are read as non-name keys and skipped above.
      const values = entries.get(key.name);
      if (values) values.push(value);
      else entries.set(key.name, [value]);
    }
  }
}

const numbers = (values: Value[] | undefined): number[] =>
  (values ?? []).flatMap((v) => (v.kind === "number" ? [v.value] : []));

const IMAGE_FILTERS = new Set([
  "DCT",
  "DCTDecode",
  "JPX",
  "JPXDecode",
  "JBIG2Decode",
  "CCF",
  "CCITTFaxDecode",
]);
const isFlate = (name: string) => name === "Fl" || name === "FlateDecode";

/**
 * Refuses a stream's filters unless each is one the inflate scan below can vouch for: flate at
 * the outside at most once, since the scan reads a stream's raw bytes, then at most one image
 * filter, which a text-only parse never decodes. Anything else could hide a bomb from the scan:
 * flate inside ASCIIHex or inside flate, or LZW, which also expands past 1,000:1. A filter behind
 * a reference is refused too: it could resolve to any of those. None of the real samples has one.
 */
function checkFilters(dict: Dict): void {
  for (const key of ["F", "Filter"]) {
    for (const value of dict.entries.get(key) ?? []) {
      const names = value.kind === "list" ? value.items : [value];
      const filters = names.map((n) => (n.kind === "name" ? n.name : null));
      const allowed =
        filters.length <= 2 &&
        filters.every((name, i) => {
          if (name === null) return false;
          if (isFlate(name)) return i === 0;
          return IMAGE_FILTERS.has(name) && i === filters.length - 1;
        });
      if (!allowed) throw unreadable("A stream filter that can't be checked first");
    }
  }
}

/** Where a stream's data starts, given the end of its keyword, as pdf.js's `skipToNextLine`. */
function dataStart(bytes: Uint8Array, from: number): number {
  for (let at = from; at < bytes.length; at++) {
    if (bytes[at] === 0x0d) return bytes[at + 1] === 0x0a ? at + 2 : at + 1;
    if (bytes[at] === 0x0a) return at + 1;
  }
  return bytes.length;
}

/** A zlib header by pdf.js's own test, which is looser than zlib's: it ignores the window size. */
function zlibHeaderAt(bytes: Uint8Array, at: number): boolean {
  const cmf = bytes[at];
  const flg = bytes[at + 1];
  if (cmf === undefined || flg === undefined) return false;
  return (cmf & 0x0f) === 8 && ((cmf << 8) + flg) % 31 === 0 && (flg & 0x20) === 0;
}

/** What a scan has spent: bytes inflated, and bytes fed to the inflater. */
interface Budget {
  inflated: number;
  fed: number;
}

/**
 * Inflates one stream until its deflate data ends or the file does, and returns the bytes it made.
 * Keeps them only for `keep`, an object stream the scan reads next. Refuses the file when they
 * pass a budget. Corrupt data is refused too, not skipped: fflate is stricter than pdf.js, which
 * reads on past a bad back-reference, so a stream fflate can't read may still inflate far in the
 * parser.
 */
function inflateStream(
  bytes: Uint8Array,
  start: number,
  budget: Budget,
  keep: Uint8Array[] | null,
): number {
  let made = 0;
  const inflater = new Inflate((chunk) => {
    made += chunk.length;
    budget.inflated += chunk.length;
    if (keep !== null && made <= PDF_LIMITS.maxStreamInflatedBytes) keep.push(chunk);
  });
  // fflate has no public "finished" flag. A finished stream has its last-block flag set and no
  // block in progress. `pdf-preflight.node.test.ts` fails if a later fflate moves them.
  // SAFETY: the two fields of fflate's inflate state read here.
  const state = (inflater as unknown as { s: { f?: number; l?: unknown } }).s;
  for (let at = start + 2; at < bytes.length; at += PUSH_BYTES) {
    // Real streams don't overlap, so they feed each byte once. Overlapping ones are refused
    // rather than read over and over.
    budget.fed += PUSH_BYTES;
    if (budget.fed > 2 * bytes.length + 2 * MiB) throw unreadable("Overlapping streams");
    try {
      inflater.push(bytes.subarray(at, at + PUSH_BYTES), false);
    } catch (cause) {
      throw new EpubError("pdf_unreadable", "Corrupt deflate data", { cause });
    }
    if (
      made > PDF_LIMITS.maxStreamInflatedBytes ||
      budget.inflated > PDF_LIMITS.maxInflatedBytes
    ) {
      throw new EpubError("zip_bomb", "Streams inflate too far");
    }
    if (state.f && !state.l) break;
  }
  return made;
}

/** The last `startxref` in the file's tail must land on `xref` or on an object. */
function checkStartxref(bytes: Uint8Array): void {
  let keyword = -1;
  for (let at = bytes.length - STARTXREF.length; at >= Math.max(0, bytes.length - 2048); at--) {
    if (matches(bytes, at, STARTXREF)) {
      keyword = at;
      break;
    }
  }
  if (keyword < 0) throw unreadable("No startxref at the end of the file");
  const reader = new Reader(bytes, { left: 2048 });
  reader.at = keyword + STARTXREF.length;
  const offset = reader.value();
  if (offset?.kind !== "number" || offset.value >= bytes.length) {
    throw unreadable("A startxref past the end of the file");
  }
  let at = offset.value;
  while (isSpace(bytes[at])) at++;
  if (matches(bytes, at, XREF)) return;
  // `<number> <number> obj`, as a cross-reference stream's offset lands on.
  const start = at;
  while (isDigit(bytes[at])) at++;
  const first = at > start;
  while (isSpace(bytes[at])) at++;
  const generation = at;
  while (isDigit(bytes[at])) at++;
  const second = at > generation;
  while (isSpace(bytes[at])) at++;
  if (!first || !second || !matches(bytes, at, OBJ)) {
    throw unreadable("A startxref that lands on neither xref nor an object");
  }
}

/** What a scan has seen of the file's objects, to compare against the limit. */
interface Counts {
  objects: number;
  /** Entries in cross-reference tables and streams. */
  entries: number;
}

function checkDictLimits(dict: Dict): void {
  if (dict.entries.has("Encrypt")) throw unreadable("Encrypted");
  for (const size of numbers(dict.entries.get("Size"))) {
    if (size > PDF_LIMITS.maxObjects) throw unreadable("Too many objects");
  }
}

function checkCounts(counts: Counts): void {
  if (counts.objects > PDF_LIMITS.maxObjects || counts.entries > PDF_LIMITS.maxObjects) {
    throw unreadable("Too many objects");
  }
}

/** A stream's dictionary, found at its `obj`, for when the scan reaches its keyword. */
interface StreamInfo {
  objectNumber: number | null;
  objectStream: boolean;
}

/** What the scan collects of each page's `/Contents`, to check once all objects are known. */
interface ContentsSeen {
  /** Each `/Contents` array's references, by object number. */
  lists: number[][];
  /** Objects a lone `/Contents` reference names. */
  refs: Set<number>;
  /** Inflated bytes of each stream object. */
  streamBytes: Map<number, number>;
  /** Objects that aren't streams, or aren't only streams: an array could be one of them. */
  others: Set<number>;
}

/** Refuses the `/Contents` values of `dict` that make the parser decode a stream over and over. */
function noteContents(dict: Dict, seen: ContentsSeen): void {
  for (const value of dict.entries.get("Contents") ?? []) {
    if (value.kind === "number") {
      seen.refs.add(value.value);
    } else if (value.kind === "list") {
      // A reference reads as three values: number, generation, R.
      const refs = value.items.flatMap((item, i) =>
        i % 3 === 0 && item.kind === "number" ? [item.value] : [],
      );
      if (refs.length > PDF_LIMITS.maxContentsEntries || new Set(refs).size < refs.length) {
        throw unreadable("A /Contents array that repeats or runs long");
      }
      seen.lists.push(refs);
    }
  }
}

/** A form can call itself or others any number of times. None of the real samples has one. */
function checkSubtype(dict: Dict): void {
  for (const subtype of dict.entries.get("Subtype") ?? []) {
    if (subtype.kind !== "name" || subtype.name === "Form") {
      throw unreadable("A form XObject, or a stream whose subtype can't be read");
    }
  }
}

/** The stream dictionary at an `obj`: its filters and what it says of the file's objects. */
function checkStreamDict(dict: Dict, counts: Counts): boolean {
  checkFilters(dict);
  checkSubtype(dict);
  checkDictLimits(dict);
  const type = dict.entries.get("Type") ?? [];
  const isType = (name: string) => type.some((t) => t.kind === "name" && t.name === name);
  if (isType("ObjStm")) {
    for (const n of numbers(dict.entries.get("N"))) counts.objects += n;
  }
  if (isType("XRef")) {
    for (const index of dict.entries.get("Index") ?? []) {
      if (index.kind !== "list") continue;
      index.items.forEach((item, i) => {
        if (i % 2 === 1 && item.kind === "number") counts.entries += item.value;
      });
    }
  }
  checkCounts(counts);
  return isType("ObjStm");
}

/** A cross-reference table's subsections: `<first> <count>`, then 20 bytes per entry. */
function countTable(bytes: Uint8Array, from: number, counts: Counts, work: { left: number }): void {
  const reader = new Reader(bytes, work);
  reader.at = from;
  for (;;) {
    const first = reader.value();
    if (first?.kind !== "number") return;
    const count = reader.value();
    if (count?.kind !== "number") return;
    counts.entries += count.value;
    checkCounts(counts);
    reader.at += count.value * 20;
  }
}

/** The number before an `obj` keyword, read backwards, or null when there is none. */
function objectNumberBefore(bytes: Uint8Array, keyword: number): number | null {
  let at = keyword - 1;
  const skipSpace = () => {
    while (isSpace(bytes[at])) at--;
  };
  const skipDigits = () => {
    const from = at;
    while (isDigit(bytes[at])) at--;
    return from > at;
  };
  skipSpace();
  if (!skipDigits()) return null;
  skipSpace();
  const end = at;
  if (!skipDigits() || end - at > 10) return null;
  let number = 0;
  for (let i = at + 1; i <= end; i++) number = number * 10 + (bytes[i]! - 0x30);
  return number;
}

/**
 * An object stream's objects: their numbers are not streams, and any page among them has its
 * `/Contents` read. In order from the first object: a file whose header gives other offsets can
 * hide one from this, which the rulings on #741 accept.
 */
function readObjectStream(parts: Uint8Array[], seen: ContentsSeen): void {
  const data = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    data.set(part, at);
    at += part.length;
  }
  const reader = new Reader(data, { left: 2 * data.length + 2 * MiB });
  let afterHeader = true;
  let pending: number | null = null;
  for (;;) {
    const value = reader.value();
    if (value === null) return;
    if (value.kind === "dict") noteContents(value.dict, seen);
    if (value.kind === "number" && afterHeader) {
      // Header pairs: number, offset.
      if (pending === null) {
        pending = value.value;
        seen.others.add(pending);
      } else {
        pending = null;
      }
    } else {
      afterHeader = false;
    }
  }
}

/** What the scan could only check once it had seen every object. */
function checkContents(seen: ContentsSeen): void {
  for (const ref of seen.refs) {
    if (seen.others.has(ref)) throw unreadable("/Contents that may be an array");
  }
  for (const refs of seen.lists) {
    let total = 0;
    for (const ref of refs) {
      if (seen.others.has(ref)) throw unreadable("/Contents that may be an array");
      total += seen.streamBytes.get(ref) ?? 0;
    }
    if (total > PDF_LIMITS.maxStreamInflatedBytes) throw unreadable("/Contents too long to join");
  }
}

/**
 * Refuses a file before the parser opens it: encrypted, corrupt, too many objects, a stream that
 * inflates too far, or a structure that makes the parser decode a stream over and over. Every
 * keyword in the raw bytes counts, read or not, and a stream's data is scanned like the rest:
 * pdf.js finds objects through a cross-reference table that can point anywhere, so a stream
 * "inside" another stream, or one with a false `/Length`, is still reachable. A stream can't live
 * inside an object stream, so none is hidden from this.
 *
 * It doesn't bound everything: pdf.js decodes a stream once per reference, so a file with many
 * pages naming one big stream still costs time, and one this misses can still kill the isolate.
 * That file gets the normal retries, then `parse_failed` (the operator's ruling on #741).
 */
export function preflightPdf(bytes: Uint8Array): void {
  checkStartxref(bytes);
  const budget: Budget = { inflated: 0, fed: 0 };
  const counts: Counts = { objects: 0, entries: 0 };
  const seen: ContentsSeen = {
    lists: [],
    refs: new Set(),
    streamBytes: new Map(),
    others: new Set(),
  };
  const streams = new Map<number, StreamInfo>();
  const work = { left: 2 * bytes.length + 2 * MiB };
  const reader = new Reader(bytes, work);
  for (let at = 0; at < bytes.length; at++) {
    const b = bytes[at];
    if (b === 0x73 /* s */ && matches(bytes, at, STREAM) && !matches(bytes, at - 3, END)) {
      const start = dataStart(bytes, at + STREAM.length);
      if (zlibHeaderAt(bytes, start)) {
        const info = streams.get(at);
        const keep = info?.objectStream ? ([] as Uint8Array[]) : null;
        const made = inflateStream(bytes, start, budget, keep);
        if (info && info.objectNumber !== null) seen.streamBytes.set(info.objectNumber, made);
        if (keep !== null) readObjectStream(keep, seen);
      }
      at += STREAM.length - 1;
    } else if (b === 0x6f /* o */ && matches(bytes, at, OBJ) && !matches(bytes, at - 3, END)) {
      if (isLetter(bytes[at + OBJ.length])) continue;
      counts.objects++;
      checkCounts(counts);
      const objectNumber = objectNumberBefore(bytes, at);
      reader.at = at + OBJ.length;
      reader.skipSpace();
      const dict = bytes[reader.at] === 0x3c && bytes[reader.at + 1] === 0x3c ? reader.dict() : null;
      if (dict !== null) noteContents(dict, seen);
      reader.skipSpace();
      if (dict !== null && matches(bytes, reader.at, STREAM)) {
        const objectStream = checkStreamDict(dict, counts);
        const earlier = streams.get(reader.at)?.objectStream ?? false;
        streams.set(reader.at, { objectNumber, objectStream: objectStream || earlier });
      } else if (objectNumber !== null) {
        seen.others.add(objectNumber);
      }
    } else if (b === 0x74 /* t */ && matches(bytes, at, TRAILER)) {
      reader.at = at + TRAILER.length;
      reader.skipSpace();
      if (bytes[reader.at] !== 0x3c || bytes[reader.at + 1] !== 0x3c) continue;
      const dict = reader.dict();
      if (dict !== null) checkDictLimits(dict);
    } else if (
      b === 0x78 /* x */ &&
      matches(bytes, at, XREF) &&
      !matches(bytes, at - 5, START) &&
      isSpace(bytes[at + XREF.length])
    ) {
      countTable(bytes, at + XREF.length, counts, work);
    }
  }
  checkContents(seen);
}
