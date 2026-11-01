import { strFromU8, Unzip, UnzipInflate, type UnzipFile } from "fflate";
import { EpubError } from "./errors";

const MiB = 1024 * 1024;

export const LIMITS = {
  maxInputBytes: 25 * MiB,
  maxEntries: 2_000,
  maxTotalBytes: 40 * MiB,
  maxEntryBytes: 20 * MiB,
  maxImageBytes: 5 * MiB,
  /**
   * Elements plus text nodes across every parsed document. Bounds tree memory
   * inside a 128 MB Worker (plus one chapter's copy at a time while chapters
   * are serialized); also caps the largest work accepted. A guess until
   * measured against real long works.
   */
  maxNodes: 300_000,
} as const;

// Compressed bytes fed to the inflater at a time. Deflate expands at most about
// 1032:1, so one push can produce at most ~16 MiB before the limits are checked.
const PUSH_BYTES = 16 * 1024;

function isSafeName(name: string): boolean {
  if (name === "" || name.includes("\\") || name.includes("\0")) return false;
  if (name.startsWith("/") || /^[A-Za-z]:/.test(name)) return false;
  return !name.split("/").includes("..");
}

// Entries the processor can read. Others (fonts, CSS, SVG) are counted and
// name-checked but never inflated or kept in memory.
export const READABLE = /^mimetype$|\.(?:x?html?|xht|xml|opf|ncx|png|jpe?g|jpe|jfif|gif|webp)$/i;

const corrupt = (why: string) => new EpubError("not_epub", `Corrupt zip: ${why}`);

/**
 * Checks the central directory (the zip's file index) before anything is
 * inflated: names, entry count and declared sizes. Returns each entry's name
 * decoded both as UTF-8 and as Latin-1, so the caller can confirm the local
 * headers it streams list the same entries even when a writer set the UTF-8
 * flag in only one of the two headers. Unzip tools read names from here.
 */
function readCentralDirectory(bytes: Uint8Array): [string, string][] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw corrupt("no central directory");
  const count = view.getUint16(eocd + 10, true);
  const size = view.getUint32(eocd + 12, true);
  const offset = view.getUint32(eocd + 16, true);
  if (count === 0xffff || offset === 0xffffffff)
    throw new EpubError("not_epub", "ZIP64 archives are not supported");
  if (count > LIMITS.maxEntries)
    throw new EpubError("zip_bomb", `More than ${LIMITS.maxEntries} entries`);
  if (offset + size > eocd) throw corrupt("central directory out of range");

  const names: [string, string][] = [];
  let declared = 0;
  let at = offset;
  for (let i = 0; i < count; i++) {
    if (at + 46 > eocd || view.getUint32(at, true) !== 0x02014b50)
      throw corrupt("bad central directory entry");
    const entryBytes = view.getUint32(at + 24, true);
    const nameEnd = at + 46 + view.getUint16(at + 28, true);
    if (nameEnd > eocd) throw corrupt("bad central directory entry");
    const raw = bytes.subarray(at + 46, nameEnd);
    const decoded: [string, string] = [strFromU8(raw), strFromU8(raw, true)];
    for (const name of decoded) {
      if (!isSafeName(name))
        throw new EpubError("not_epub", `Unsafe entry name: ${JSON.stringify(name)}`);
    }
    if (entryBytes > LIMITS.maxEntryBytes) {
      throw new EpubError(
        "zip_bomb",
        `Entry declares more than ${LIMITS.maxEntryBytes} bytes: ${decoded[0]}`,
      );
    }
    declared += entryBytes;
    if (declared > LIMITS.maxTotalBytes)
      throw new EpubError("zip_bomb", `Archive declares more than ${LIMITS.maxTotalBytes} bytes`);
    names.push(decoded);
    at = nameEnd + view.getUint16(at + 30, true) + view.getUint16(at + 32, true);
  }
  return names;
}

function concat(chunks: Uint8Array[], size: number): Uint8Array {
  if (chunks.length === 1) return chunks[0]!;
  const out = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

/**
 * Unzips with hard limits. Uses fflate's streaming `Unzip` so the limits apply
 * to bytes actually inflated, not to the sizes the zip declares about itself.
 * Directory entries count toward the entry limit but are not returned, and
 * neither are entries the processor cannot read (see READABLE).
 */
export function unzipEpub(bytes: Uint8Array): Map<string, Uint8Array> {
  if (
    bytes.length < 4 ||
    bytes[0] !== 0x50 ||
    bytes[1] !== 0x4b ||
    bytes[2] !== 0x03 ||
    bytes[3] !== 0x04
  ) {
    throw new EpubError("not_epub", "Not a zip file");
  }
  const indexed = readCentralDirectory(bytes);

  const files = new Map<string, Uint8Array>();
  const seen = new Set<string>();
  let entries = 0;
  let total = 0;
  let pending = 0;
  // SAFETY: widens the initial null, so TS doesn't read it as null after the callbacks have run.
  let failure = null as EpubError | null;
  const fail = (err: EpubError, file?: UnzipFile) => {
    failure ??= err;
    file?.terminate();
  };

  const unzip = new Unzip((file) => {
    if (failure) return;
    entries++;
    if (entries > LIMITS.maxEntries)
      return fail(new EpubError("zip_bomb", `More than ${LIMITS.maxEntries} entries`));
    const name = file.name;
    if (!isSafeName(name))
      return fail(new EpubError("not_epub", `Unsafe entry name: ${JSON.stringify(name)}`));
    // Two entries with one name could be read differently by different tools.
    if (seen.has(name))
      return fail(new EpubError("not_epub", `Duplicate entry: ${JSON.stringify(name)}`));
    seen.add(name);
    if ((file.originalSize ?? 0) > LIMITS.maxEntryBytes) {
      return fail(
        new EpubError(
          "zip_bomb",
          `Entry declares more than ${LIMITS.maxEntryBytes} bytes: ${name}`,
        ),
      );
    }

    const isDir = name.endsWith("/");
    if (isDir || !READABLE.test(name)) return; // never started, so never inflated
    const chunks: Uint8Array[] = [];
    let size = 0;
    pending++;
    file.ondata = (err, data, final) => {
      if (failure) return;
      if (err)
        return fail(new EpubError("not_epub", `Corrupt entry ${name}: ${err.message}`), file);
      size += data.length;
      total += data.length;
      if (size > LIMITS.maxEntryBytes) {
        return fail(
          new EpubError("zip_bomb", `Entry inflates past ${LIMITS.maxEntryBytes} bytes: ${name}`),
          file,
        );
      }
      if (total > LIMITS.maxTotalBytes) {
        return fail(
          new EpubError("zip_bomb", `Archive inflates past ${LIMITS.maxTotalBytes} bytes`),
          file,
        );
      }
      if (data.length) chunks.push(data);
      if (final) {
        pending--;
        files.set(name, concat(chunks, size));
      }
    };
    try {
      file.start();
    } catch (e) {
      // SAFETY: fflate throws Error objects. Another value's message reads as "undefined"; a
      // thrown null or undefined raises a TypeError, which the catch around push reports.
      fail(new EpubError("not_epub", `Cannot read entry ${name}: ${(e as Error).message}`));
    }
  });
  unzip.register(UnzipInflate);

  try {
    // In bounded chunks: a single push of the whole archive would inflate an
    // entry with a falsified size in one allocation, before `ondata` runs.
    for (let at = 0; at < bytes.length && !failure; at += PUSH_BYTES) {
      const end = Math.min(at + PUSH_BYTES, bytes.length);
      unzip.push(bytes.subarray(at, end), end === bytes.length);
    }
  } catch (e) {
    if (!failure)
      // SAFETY: fflate throws Error objects. Another value's message reads as "undefined"; a
      // thrown null or undefined escapes as a TypeError, not an EpubError.
      throw new EpubError("not_epub", `Unreadable zip: ${(e as Error).message}`, { cause: e });
  }
  if (failure) throw failure;
  if (pending > 0) throw new EpubError("not_epub", "Truncated zip");
  // The index and the local headers must describe the same entries, or other
  // tools would see a different archive from the one checked here.
  if (
    indexed.length !== seen.size ||
    !indexed.every(([utf8, latin1]) => seen.has(utf8) || seen.has(latin1))
  ) {
    throw corrupt("central directory and local headers disagree");
  }
  return files;
}
