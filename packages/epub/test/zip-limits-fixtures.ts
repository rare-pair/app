import { strToU8, unzipSync } from "fflate";
import { ao3Epub, zipEntries } from "./helpers";

// Fixtures for the unzip size and count limits, built from the synthetic epub.
// Structure only, no real fanwork text.

/**
 * Calls `patch` on the local header and the central directory entry for
 * `name` (with the offsets of their uncompressed size and name); returns how
 * many headers it found.
 */
export function patchHeaders(
  zip: Uint8Array,
  name: string,
  patch: (view: DataView, local: boolean, sizeAt: number, nameAt: number) => void,
): number {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const want = strToU8(name);
  let found = 0;
  for (let at = 0; at + 46 <= zip.length; at++) {
    const sig = view.getUint32(at, true);
    const local = sig === 0x04034b50;
    if (!local && sig !== 0x02014b50) continue;
    const nameAt = at + (local ? 30 : 46);
    if (view.getUint16(at + (local ? 26 : 28), true) !== want.length) continue;
    if (!want.every((b, i) => zip[nameAt + i] === b)) continue;
    patch(view, local, at + (local ? 22 : 24), nameAt);
    found++;
  }
  return found;
}

/** The synthetic epub's entries except `mimetype`, which `zipEntries` adds back. */
export function baseEntries(): Record<string, Uint8Array> {
  const { mimetype: _, ...rest } = unzipSync(ao3Epub());
  return rest;
}

const sum = (entries: Record<string, Uint8Array>) =>
  Object.values(entries).reduce((n, data) => n + data.length, 0);

/** Uncompressed bytes of every entry of the synthetic epub, `mimetype` included. */
export const BASE_TOTAL = sum(unzipSync(ao3Epub()));

/**
 * The same without `stylesheet.css`, the one entry the unzipper counts in the
 * index but never inflates: what the streaming total sees.
 */
export const BASE_INFLATED = BASE_TOTAL - baseEntries()["stylesheet.css"]!.length;

/** The synthetic epub plus one all-zero `pad<N>.xml` entry per size. */
export function padded(sizes: number[]): Uint8Array {
  const entries = baseEntries();
  sizes.forEach((n, i) => {
    entries[`pad${i}.xml`] = new Uint8Array(n);
  });
  return zipEntries(entries);
}

/** The synthetic epub plus `extra` one-byte entries, `count` zip entries in all. */
export function withEntryCount(count: number): Uint8Array {
  const entries = baseEntries();
  const extra = count - (Object.keys(entries).length + 1);
  for (let i = 0; i < extra; i++) entries[`f${i}.txt`] = strToU8("x");
  return zipEntries(entries);
}

/**
 * Makes both headers of `name` declare 1 KiB, whatever the entry inflates to;
 * returns how many headers it patched (2 when both were found).
 */
export function understate(zip: Uint8Array, name: string): number {
  return patchHeaders(zip, name, (view, _local, sizeAt) => view.setUint32(sizeAt, 1024, true));
}
