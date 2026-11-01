import { strToU8 } from "fflate";
import { patchHeaders } from "./zip-limits-fixtures";

// Byte-level builders for the zip-structure tests. Structure only, no real fanwork text.

const viewOf = (zip: Uint8Array) => new DataView(zip.buffer, zip.byteOffset, zip.byteLength);

/** Offset of the End Of Central Directory record. */
export function eocdAt(zip: Uint8Array): number {
  const view = viewOf(zip);
  for (let i = zip.length - 22; i >= 0; i--) if (view.getUint32(i, true) === 0x06054b50) return i;
  throw new Error("no EOCD in the fixture");
}

/** Lowers the entry count in the EOCD by one, so the index lists one entry fewer. */
export function dropOneFromCount(zip: Uint8Array): void {
  const view = viewOf(zip);
  const at = eocdAt(zip);
  view.setUint16(at + 8, view.getUint16(at + 8, true) - 1, true);
  view.setUint16(at + 10, view.getUint16(at + 10, true) - 1, true);
}

/**
 * Overwrites `name`'s bytes with `to` (same length) in the headers `which`
 * selects; returns how many headers it changed.
 */
export function renameEntry(
  zip: Uint8Array,
  name: string,
  to: string,
  which: "both" | "central" | "local" = "both",
): number {
  const bytes = strToU8(to);
  let changed = 0;
  patchHeaders(zip, name, (_view, local, _size, nameAt) => {
    if (which === "central" && local) return;
    if (which === "local" && !local) return;
    zip.set(bytes, nameAt);
    changed++;
  });
  return changed;
}

/** Inserts `record` into `zip` just before the EOCD, which moves right. */
function insertBeforeEocd(zip: Uint8Array, record: Uint8Array): Uint8Array {
  const at = eocdAt(zip);
  const out = new Uint8Array(zip.length + record.length);
  out.set(zip.subarray(0, at), 0);
  out.set(record, at);
  out.set(zip.subarray(at), at + record.length);
  return out;
}

/** A ZIP64 EOCD record (56 bytes) followed by its locator (20 bytes), holding the real small values. */
function zip64Tail(zip: Uint8Array): Uint8Array {
  const at = eocdAt(zip);
  const view = viewOf(zip);
  const tail = new Uint8Array(76);
  const t = viewOf(tail);
  t.setUint32(0, 0x06064b50, true);
  t.setBigUint64(4, 44n, true);
  t.setUint16(12, 45, true);
  t.setUint16(14, 45, true);
  t.setBigUint64(24, BigInt(view.getUint16(at + 10, true)), true);
  t.setBigUint64(32, BigInt(view.getUint16(at + 10, true)), true);
  t.setBigUint64(40, BigInt(view.getUint32(at + 12, true)), true);
  t.setBigUint64(48, BigInt(view.getUint32(at + 16, true)), true);
  t.setUint32(56, 0x07064b50, true);
  t.setBigUint64(64, BigInt(at), true);
  t.setUint32(72, 1, true);
  return tail;
}

/** A copy with the EOCD entry counts at 0xffff, or its central directory offset at 0xffffffff. */
export function markEocd(zip: Uint8Array, field: "count" | "offset"): Uint8Array {
  const out = zip.slice();
  const view = viewOf(out);
  const at = eocdAt(out);
  if (field === "count") {
    view.setUint16(at + 8, 0xffff, true);
    view.setUint16(at + 10, 0xffff, true);
  } else view.setUint32(at + 16, 0xffffffff, true);
  return out;
}

/** The realistic form: a ZIP64 EOCD record and locator, with the EOCD fields set to the maximum. */
export function withZip64Eocd(zip: Uint8Array): Uint8Array {
  return markEocd(markEocd(insertBeforeEocd(zip, zip64Tail(zip)), "count"), "offset");
}

/** A ZIP64 record and locator that the EOCD does not use: its own fields keep their real values. */
export function withUnusedZip64Locator(zip: Uint8Array): Uint8Array {
  return insertBeforeEocd(zip, zip64Tail(zip));
}

/**
 * Gives `name`'s central entry a Zip64 extra field (id 0x0001) and declares its
 * sizes as 0xffffffff, as a ZIP64 writer does; the archive itself stays small.
 */
export function withZip64Extra(
  zip: Uint8Array,
  name: string,
  { maxSizes = true, after = 0, overrun = false, id = 0x0001 } = {},
): Uint8Array {
  // `after` empty unknown fields (id 0x7777) come first; `overrun` makes the last one claim more
  // bytes than the extra block holds.
  const extra = new Uint8Array(after * 4 + 12);
  const e = viewOf(extra);
  for (let i = 0; i < after; i++) {
    e.setUint16(i * 4, 0x7777, true);
    e.setUint16(i * 4 + 2, overrun ? 0x1000 : 0, true);
  }
  e.setUint16(after * 4, id, true);
  e.setUint16(after * 4 + 2, 8, true);
  let entryAt = -1;
  patchHeaders(zip, name, (_view, local, _size, nameAt) => {
    if (!local) entryAt = nameAt - 46;
  });
  if (entryAt < 0) throw new Error("no central entry in the fixture");
  const nameEnd = entryAt + 46 + strToU8(name).length;
  const out = new Uint8Array(zip.length + extra.length);
  out.set(zip.subarray(0, nameEnd), 0);
  out.set(extra, nameEnd);
  out.set(zip.subarray(nameEnd), nameEnd + extra.length);
  const view = viewOf(out);
  view.setUint16(entryAt + 30, view.getUint16(entryAt + 30, true) + extra.length, true);
  if (maxSizes) {
    view.setUint32(entryAt + 20, 0xffffffff, true);
    view.setUint32(entryAt + 24, 0xffffffff, true);
  }
  const eocd = eocdAt(out);
  view.setUint32(eocd + 12, view.getUint32(eocd + 12, true) + extra.length, true);
  return out;
}
