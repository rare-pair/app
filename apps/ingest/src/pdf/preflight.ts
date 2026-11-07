import { EpubError } from "@archive/epub";
import { Inflate } from "fflate";
import { PDF_LIMITS } from "./limits";

const MiB = 1024 * 1024;

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
  /** `4 0 R`, by its object number. */
  | { kind: "ref"; object: number }
  | { kind: "other" };

/** A dictionary's top-level entries the checks read, a repeated key keeping every value. */
type Dict = Map<string, Value[]>;

/** The keys any check reads. Nothing else is kept, or a file of values fills the isolate's memory. */
const KEPT_KEYS = new Set([
  "Contents",
  "Encrypt",
  "F",
  "Filter",
  "First",
  "Index",
  "N",
  "Size",
  "Subtype",
  "Type",
]);
/** The most values kept from a list under one of those. A real one has a few. */
const MAX_KEPT_ITEMS = 4096;
/** How deep lists and dictionaries nest. Real files go a few levels, and pdf.js recurses too. */
const MAX_DEPTH = 64;

/**
 * Reads PDF tokens as pdf.js's lexer does: comments, strings with nested brackets and escapes,
 * hex strings, names with `#xx` escapes. Bounded by `work`, a budget of bytes read that survives
 * from one dictionary to the next, so a file of overlapping `obj<<` can't make it quadratic.
 */
class Reader {
  at = 0;
  private depth = 0;

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

  /** A number as pdf.js's lexer reads one: any signs, decimals, and it ends where it stops. */
  private number(): Value {
    const from = this.at;
    const { bytes } = this;
    while (bytes[this.at] === 0x2b || bytes[this.at] === 0x2d) this.at++;
    let value = 0;
    let scale = 0;
    for (;;) {
      const b = bytes[this.at];
      if (b === 0x2e && scale === 0) scale = 1;
      else if (isDigit(b)) {
        if (scale === 0) value = value * 10 + (b! - 0x30);
        else value += (b! - 0x30) / (scale *= 10);
      } else if (b !== 0x2d) break;
      this.at++;
    }
    this.spend(from);
    return { kind: "number", value };
  }

  /** A keyword, or a delimiter no value starts with, such as a stray `)`: one byte. */
  private keyword(): Value {
    const from = this.at;
    const { bytes } = this;
    if (endsToken(bytes[this.at])) this.at++;
    else while (!endsToken(bytes[this.at])) this.at++;
    this.spend(from);
    return { kind: "other" };
  }

  private word(): Value {
    const b = this.bytes[this.at];
    if (!isDigit(b) && b !== 0x2b && b !== 0x2d && b !== 0x2e) return this.keyword();
    const first = this.number();
    return first.kind === "number" && Number.isInteger(first.value) ? this.refFrom(first) : first;
  }

  /** `first` as a reference, if a whole number and an R follow it, as pdf.js looks ahead for them. */
  private refFrom(first: { kind: "number"; value: number }): Value {
    const after = this.at;
    const { bytes } = this;
    this.skipSpace();
    const b = bytes[this.at];
    if (isDigit(b) || b === 0x2b || b === 0x2d || b === 0x2e) {
      const generation = this.number();
      this.skipSpace();
      if (
        generation.kind === "number" &&
        Number.isInteger(generation.value) &&
        bytes[this.at] === 0x52 &&
        endsToken(bytes[this.at + 1])
      ) {
        this.at++;
        return { kind: "ref", object: first.value };
      }
    }
    this.at = after;
    return first;
  }

  /** Past one token, as pdf.js does for a dictionary key that isn't a name. */
  private skipToken(): void {
    const { bytes } = this;
    const b = bytes[this.at];
    if (b === 0x2f) this.name();
    else if (b === 0x28) this.string();
    else if (b === 0x3c && bytes[this.at + 1] === 0x3c) this.at += 2;
    else if (b === 0x3c) this.hexString();
    else if (b === 0x5b || b === 0x5d) this.at++;
    else this.word();
  }

  /**
   * One value, read past whatever it holds. Null at the end of the file. `keep` says its contents
   * are wanted: a list's items, or a dictionary's entries.
   */
  value(keep = true): Value | null {
    this.skipSpace();
    const { bytes } = this;
    const b = bytes[this.at];
    if (b === undefined) return null;
    // A `>>` where a value goes is a value to pdf.js, and the dictionary reads on.
    if (b === 0x3e && bytes[this.at + 1] === 0x3e) {
      this.at += 2;
      return { kind: "other" };
    }
    if (b === 0x2f) return this.name();
    if (b === 0x28) {
      this.string();
      return { kind: "other" };
    }
    if (b === 0x3c && bytes[this.at + 1] === 0x3c) {
      const dict = this.dict(keep);
      return dict === null ? null : { kind: "dict", dict };
    }
    if (b === 0x3c) {
      this.hexString();
      return { kind: "other" };
    }
    if (b === 0x5b) return this.list(keep);
    return this.word();
  }

  private enter(): void {
    if (++this.depth > MAX_DEPTH) throw unreadable("Nested too deep to read");
  }

  private list(keep: boolean): Value | null {
    this.at++;
    this.enter();
    const items: Value[] = [];
    for (;;) {
      this.skipSpace();
      if (this.at >= this.bytes.length) return null;
      if (this.bytes[this.at] === 0x5d) {
        this.at++;
        this.depth--;
        return { kind: "list", items };
      }
      const item = this.value(keep);
      if (item === null) return null;
      if (!keep) continue;
      if (items.length >= MAX_KEPT_ITEMS) throw unreadable("A list too long to be real");
      items.push(item);
    }
  }

  /**
   * The dictionary at `at`, which must start `<<`, read as pdf.js's parser reads it: a key that
   * isn't a name costs one token, not a whole value, and a key's value can be `>>`. Null when the
   * file ends inside it. `keep` says its entries are wanted, which only the outermost are.
   */
  dict(keep = true): Dict | null {
    this.at += 2;
    this.enter();
    const entries: Dict = new Map();
    const { bytes } = this;
    for (;;) {
      this.skipSpace();
      if (this.at >= bytes.length) return null;
      if (bytes[this.at] === 0x3e && bytes[this.at + 1] === 0x3e) {
        this.at += 2;
        this.depth--;
        return entries;
      }
      if (bytes[this.at] !== 0x2f) {
        this.skipToken();
        continue;
      }
      const key = this.name();
      if (key.kind !== "name") continue;
      const wanted = keep && KEPT_KEYS.has(key.name);
      const value = this.value(wanted);
      if (value === null) return null;
      if (!wanted) continue;
      const values = entries.get(key.name);
      if (values) values.push(value);
      else entries.set(key.name, [value]);
    }
  }
}

const numbers = (values: Value[] | undefined): number[] =>
  (values ?? []).flatMap((v) => (v.kind === "number" ? [v.value] : []));

const IMAGE_FILTERS = new Set(["DCT", "DCTDecode", "JPX", "JPXDecode"]);
const isFlate = (name: string) => name === "Fl" || name === "FlateDecode";

/**
 * Refuses a stream's filters unless each is one the inflate scan below can vouch for: flate at
 * the outside at most once, since the scan reads a stream's raw bytes, then at most one image
 * filter, on a stream that says it's an image. pdf.js decodes any filter on a stream it reads as
 * text, and an image decoder has no budget, so `checkContents` refuses `/Contents` that names one,
 * and CCITT and JBIG2, which a text PDF has no use for and which need only a few bytes to ask for
 * hundreds of MB, are refused outright. Anything else could hide a bomb from the scan: flate
 * inside ASCIIHex or inside flate, or LZW, which also expands past 1,000:1. A filter behind a
 * reference is refused too: it could resolve to any of those. None of the real samples has one.
 * Says whether the stream has an image filter.
 */
function checkFilters(dict: Dict): boolean {
  let image = false;
  for (const key of ["F", "Filter"]) {
    for (const value of dict.get(key) ?? []) {
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
      image ||= filters.some((name) => name !== null && IMAGE_FILTERS.has(name));
    }
  }
  const subtypes = dict.get("Subtype") ?? [];
  if (image && !subtypes.some((s) => s.kind === "name" && s.name === "Image")) {
    throw unreadable("An image filter on a stream that isn't an image");
  }
  return image;
}

/** Where a stream's data starts, given the end of its keyword, as pdf.js's `skipToNextLine`. */
function dataStart(bytes: Uint8Array, from: number, work: { left: number }): number {
  let at = from;
  while (at < bytes.length && bytes[at] !== 0x0d && bytes[at] !== 0x0a) at++;
  // Charged, or a file of keywords with no line end is read to its end once per keyword.
  work.left -= at - from;
  if (work.left < 0) throw unreadable("Too much to read in dictionaries");
  if (at >= bytes.length) return bytes.length;
  return bytes[at] === 0x0d && bytes[at + 1] === 0x0a ? at + 2 : at + 1;
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
  // oxlint-disable-next-line deslop/no-chained-type-assertions, deslop/no-known-value-widening -- private to fflate, and a test holds it
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
    if (made > PDF_LIMITS.maxStreamInflatedBytes || budget.inflated > PDF_LIMITS.maxInflatedBytes) {
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
  if (dict.has("Encrypt")) throw unreadable("Encrypted");
  for (const size of numbers(dict.get("Size"))) {
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
  /** How many objects it holds, for an object stream. */
  objectCount: number | null;
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
  /** Stream objects with an image filter, whose decoders have no budget. */
  images: Set<number>;
}

/** Refuses the `/Contents` values of `dict` that make the parser decode a stream over and over. */
function noteContents(dict: Dict, seen: ContentsSeen): void {
  for (const value of dict.get("Contents") ?? []) {
    if (value.kind === "ref") {
      seen.refs.add(value.object);
    } else if (value.kind === "list") {
      const refs = value.items.flatMap((item) => (item.kind === "ref" ? [item.object] : []));
      if (refs.length > PDF_LIMITS.maxContentsEntries || new Set(refs).size < refs.length) {
        throw unreadable("A /Contents array that repeats or runs long");
      }
      seen.lists.push(refs);
    }
  }
}

/** A form can call itself or others any number of times. None of the real samples has one. */
function checkSubtype(dict: Dict): void {
  for (const subtype of dict.get("Subtype") ?? []) {
    if (subtype.kind !== "name" || subtype.name === "Form") {
      throw unreadable("A form XObject, or a stream whose subtype can't be read");
    }
  }
}

/**
 * The stream dictionary at an `obj`: its filters and what it says of the file's objects. Returns
 * whether it has an image filter, and how many objects it holds if it's an object stream, as pdf.js
 * takes it: any stream with a `/First` or `/N`, whatever its `/Type` says.
 */
function checkStreamDict(dict: Dict, counts: Counts) {
  const image = checkFilters(dict);
  checkSubtype(dict);
  checkDictLimits(dict);
  const type = dict.get("Type") ?? [];
  const isType = (name: string) => type.some((t) => t.kind === "name" && t.name === name);
  let objectCount: number | null = null;
  if (isType("ObjStm") || dict.has("First") || dict.has("N")) {
    // Behind a reference, or under an image filter, there'd be no reading what it holds.
    const [n, ...others] = dict.get("N") ?? [];
    const first = dict.get("First")?.[0];
    if (n?.kind !== "number" || others.length > 0 || first?.kind !== "number" || image) {
      throw unreadable("An object stream that can't be read first");
    }
    objectCount = n.value;
    counts.objects += objectCount;
  }
  if (isType("XRef")) {
    for (const index of dict.get("Index") ?? []) {
      if (index.kind !== "list") continue;
      index.items.forEach((item, i) => {
        if (i % 2 === 1 && item.kind === "number") counts.entries += item.value;
      });
    }
  }
  checkCounts(counts);
  return { image, objectCount };
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

/** Whether object-stream data holds a stream: `>>`, whitespace, then the keyword. */
function holdsStream(data: Uint8Array): boolean {
  for (let at = 0; at + STREAM.length <= data.length; at++) {
    if (data[at] !== STREAM[0] || !matches(data, at, STREAM)) continue;
    let before = at - 1;
    while (isSpace(data[before])) before--;
    if (data[before] === 0x3e && data[before - 1] === 0x3e) return true;
  }
  return false;
}

/**
 * An object stream's objects: their numbers are not streams, and any page among them has its
 * `/Contents` read. pdf.js parses a stream inside one, though the format says none can be, so one is
 * refused. In order from the first object: a file whose header gives other offsets can hide a page
 * from this, which the rulings on #741 accept.
 */
function readObjectStream(data: Uint8Array, count: number, seen: ContentsSeen): void {
  if (holdsStream(data)) throw unreadable("A stream inside an object stream");
  const reader = new Reader(data, { left: 4 * data.length + 2 * MiB });
  for (let i = 0; i < count; i++) {
    const number = reader.value();
    if (number === null) return;
    if (number.kind === "number") seen.others.add(number.value);
    if ((reader.value() ?? { kind: "other" }).kind !== "number") return;
  }
  for (let i = 0; i < count; i++) {
    const value = reader.value();
    if (value === null) return;
    if (value.kind === "dict") noteContents(value.dict, seen);
    reader.skipSpace();
  }
}

const joined = (parts: Uint8Array[]): Uint8Array => {
  const data = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    data.set(part, at);
    at += part.length;
  }
  return data;
};

/** An object stream with no filter: its raw bytes, to its first `endstream` or the file's end. */
function rawStreamData(bytes: Uint8Array, start: number): Uint8Array {
  for (let at = start; at < bytes.length; at++) {
    if (bytes[at] === 0x65 && matches(bytes, at, END) && matches(bytes, at + END.length, STREAM)) {
      return bytes.subarray(start, at);
    }
  }
  return bytes.subarray(start);
}

/** What the scan could only check once it had seen every object. */
function checkContents(seen: ContentsSeen): void {
  const check = (ref: number) => {
    if (seen.others.has(ref)) throw unreadable("/Contents that may be an array");
    if (seen.images.has(ref)) throw unreadable("/Contents that names an image");
  };
  for (const ref of seen.refs) check(ref);
  for (const refs of seen.lists) {
    let total = 0;
    for (const ref of refs) {
      check(ref);
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
    images: new Set(),
  };
  const streams = new Map<number, StreamInfo>();
  // Each number reads the two tokens after it twice, looking for a reference.
  const work = { left: 4 * bytes.length + 2 * MiB };
  const reader = new Reader(bytes, work);
  for (let at = 0; at < bytes.length; at++) {
    const b = bytes[at];
    if (b === 0x73 /* s */ && matches(bytes, at, STREAM) && !matches(bytes, at - 3, END)) {
      const start = dataStart(bytes, at + STREAM.length, work);
      const info = streams.get(at);
      const count = info?.objectCount ?? null;
      const parts: Uint8Array[] = [];
      if (zlibHeaderAt(bytes, start)) {
        const made = inflateStream(bytes, start, budget, count === null ? null : parts);
        if (info && info.objectNumber !== null) seen.streamBytes.set(info.objectNumber, made);
        if (count !== null) readObjectStream(joined(parts), count, seen);
      } else if (count !== null) {
        readObjectStream(rawStreamData(bytes, start), count, seen);
      }
      at += STREAM.length - 1;
    } else if (b === 0x6f /* o */ && matches(bytes, at, OBJ) && !matches(bytes, at - 3, END)) {
      if (isLetter(bytes[at + OBJ.length])) continue;
      counts.objects++;
      checkCounts(counts);
      const objectNumber = objectNumberBefore(bytes, at);
      reader.at = at + OBJ.length;
      reader.skipSpace();
      const dict =
        bytes[reader.at] === 0x3c && bytes[reader.at + 1] === 0x3c ? reader.dict() : null;
      if (dict !== null) noteContents(dict, seen);
      reader.skipSpace();
      if (dict !== null && matches(bytes, reader.at, STREAM)) {
        const { image, objectCount } = checkStreamDict(dict, counts);
        const earlier = streams.get(reader.at)?.objectCount ?? null;
        streams.set(reader.at, { objectNumber, objectCount: objectCount ?? earlier });
        if (image && objectNumber !== null) seen.images.add(objectNumber);
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
