// Deflate as pdf.js reads it, to find out how much a stream makes before pdf.js is let near it. A
// port of FlateStream in unpdf's pdf.js, on purpose: a stricter or looser decoder disagrees with
// it on a crafted stream (an over-subscribed code table, a distance past the start), and a stream
// that ends at once for one can run to 1000:1 for the other. Keep it the same if unpdf moves.

/** Deflate data pdf.js would throw on, too. */
export class BadDeflate extends Error {}

const CODE_LENGTH_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
const LENGTHS = [
  3, 4, 5, 6, 7, 8, 9, 10, 65547, 65549, 65551, 65553, 131091, 131095, 131099, 131103, 196643,
  196651, 196659, 196667, 262211, 262227, 262243, 262259, 327811, 327843, 327875, 327907, 258, 258,
  258,
];
const DISTANCES = [
  1, 2, 3, 4, 65541, 65543, 131081, 131085, 196625, 196633, 262177, 262193, 327745, 327777, 393345,
  393409, 459009, 459137, 524801, 525057, 590849, 591361, 657409, 658433, 724993, 727041, 794625,
  798721, 868353, 876545,
];

interface Table {
  codes: Int32Array;
  maxLength: number;
}

function huffmanTable(lengths: Uint8Array): Table {
  let maxLength = 0;
  for (const length of lengths) if (length > maxLength) maxLength = length;
  const size = 1 << maxLength;
  const codes = new Int32Array(size);
  for (let length = 1, code = 0, skip = 2; length <= maxLength; ++length, code <<= 1, skip <<= 1) {
    for (let symbol = 0; symbol < lengths.length; ++symbol) {
      if (lengths[symbol] !== length) continue;
      let reversed = 0;
      let rest = code;
      for (let i = 0; i < length; ++i) {
        reversed = (reversed << 1) | (rest & 1);
        rest >>= 1;
      }
      for (let i = reversed; i < size; i += skip) codes[i] = (length << 16) | symbol;
      ++code;
    }
  }
  return { codes, maxLength };
}

const FIXED_LITERALS = huffmanTable(
  Uint8Array.from({ length: 288 }, (_, i) => (i < 144 ? 8 : i < 256 ? 9 : i < 280 ? 7 : 8)),
);
const FIXED_DISTANCES = huffmanTable(new Uint8Array(30).fill(5));

/** Told how far a stream has got, to refuse it when it passes a budget. */
export interface FlateWatch {
  /** Bytes made so far, bytes read so far, and table entries built so far. */
  progress: (made: number, read: number, tableEntries: number) => void;
}

/** Output kept only for an object stream, since a copy needs what's already there. */
class Output {
  private buffer = new Uint8Array(64 * 1024);
  length = 0;

  private grow(to: number): void {
    if (to <= this.buffer.length) return;
    const next = new Uint8Array(Math.max(to, this.buffer.length * 2));
    next.set(this.buffer.subarray(0, this.length));
    this.buffer = next;
  }

  literal(byte: number): void {
    this.grow(this.length + 1);
    this.buffer[this.length++] = byte;
  }

  bytes(from: Uint8Array): void {
    this.grow(this.length + from.length);
    this.buffer.set(from, this.length);
    this.length += from.length;
  }

  copy(length: number, distance: number): void {
    this.grow(this.length + length);
    const { buffer } = this;
    // A distance past the start reads as zeros, as in pdf.js.
    for (let i = 0; i < length; i++, this.length++) {
      buffer[this.length] = buffer[this.length - distance] ?? 0;
    }
  }

  get data(): Uint8Array {
    return this.buffer.subarray(0, this.length);
  }
}

/**
 * Reads the deflate data at `start`, past its two-byte header, to its last block or the end of
 * `bytes`. Returns how much it makes, and what it makes when `keep` is set. Throws `BadDeflate`
 * where pdf.js would throw, and whatever `watch` throws.
 */
export function readFlate(bytes: Uint8Array, start: number, watch: FlateWatch, keep: boolean) {
  let at = start + 2;
  let codeBuffer = 0;
  let codeSize = 0;
  let made = 0;
  let tableEntries = 0;
  const output = keep ? new Output() : null;
  const byte = (): number => (at < bytes.length ? bytes[at++]! : -1);

  const getBits = (count: number): number => {
    while (codeSize < count) {
      const next = byte();
      if (next === -1) throw new BadDeflate("Bad encoding");
      codeBuffer |= next << codeSize;
      codeSize += 8;
    }
    const value = codeBuffer & ((1 << count) - 1);
    codeBuffer >>= count;
    codeSize -= count;
    return value;
  };
  const getCode = ({ codes, maxLength }: Table): number => {
    while (codeSize < maxLength) {
      const next = byte();
      if (next === -1) break;
      codeBuffer |= next << codeSize;
      codeSize += 8;
    }
    const entry = codes[codeBuffer & ((1 << maxLength) - 1)]!;
    const length = entry >> 16;
    if (length < 1 || codeSize < length) throw new BadDeflate("Bad encoding");
    codeBuffer >>= length;
    codeSize -= length;
    return entry & 0xffff;
  };
  const table = (lengths: Uint8Array): Table => {
    const built = huffmanTable(lengths);
    tableEntries += built.codes.length;
    return built;
  };

  for (let last = false; !last;) {
    watch.progress(made, at - start, tableEntries);
    let header: number;
    try {
      header = getBits(3);
    } catch {
      // Out of data at a block's start ends the stream in pdf.js, with no error.
      break;
    }
    last = (header & 1) === 1;
    const type = header >> 1;
    if (type === 0) {
      const b0 = byte();
      const b1 = byte();
      const b2 = byte();
      const b3 = byte();
      if (b0 === -1 || b1 === -1 || b2 === -1 || b3 === -1) break;
      const length = b0 | (b1 << 8);
      const check = b2 | (b3 << 8);
      if (check !== (~length & 0xffff) && (length !== 0 || check !== 0)) {
        throw new BadDeflate("Bad stored block");
      }
      codeBuffer = 0;
      codeSize = 0;
      const stored = bytes.subarray(at, at + length);
      output?.bytes(stored);
      at += stored.length;
      made += stored.length;
      if (stored.length < length) break;
      continue;
    }
    let literals = FIXED_LITERALS;
    let distances = FIXED_DISTANCES;
    if (type === 2) {
      const literalCount = getBits(5) + 257;
      const distanceCount = getBits(5) + 1;
      const codeLengthCount = getBits(4) + 4;
      const codeLengths = new Uint8Array(CODE_LENGTH_ORDER.length);
      for (let i = 0; i < codeLengthCount; ++i) codeLengths[CODE_LENGTH_ORDER[i]!] = getBits(3);
      const codeLengthTable = table(codeLengths);
      let previous = 0;
      const total = literalCount + distanceCount;
      const lengths = new Uint8Array(total);
      for (let i = 0; i < total;) {
        const code = getCode(codeLengthTable);
        let extraBits: number;
        let base: number;
        let value: number;
        if (code === 16) {
          extraBits = 2;
          base = 3;
          value = previous;
        } else if (code === 17) {
          extraBits = 3;
          base = 3;
          value = previous = 0;
        } else if (code === 18) {
          extraBits = 7;
          base = 11;
          value = previous = 0;
        } else {
          lengths[i++] = previous = code;
          continue;
        }
        // A run past the end falls off the typed array, as in pdf.js.
        for (let run = getBits(extraBits) + base; run-- > 0;) lengths[i++] = value;
      }
      literals = table(lengths.subarray(0, literalCount));
      distances = table(lengths.subarray(literalCount, total));
    } else if (type !== 1) {
      throw new BadDeflate("Unknown block type");
    }
    for (let symbols = 0; ; symbols++) {
      // Often enough to stop in time, and not so often that it costs: a copy makes at most 258.
      if ((symbols & 0xffff) === 0xffff) watch.progress(made, at - start, tableEntries);
      const code = getCode(literals);
      if (code < 256) {
        output?.literal(code);
        made++;
        continue;
      }
      if (code === 256) break;
      const lengthEntry = LENGTHS[code - 257] ?? 0;
      const lengthExtra = lengthEntry >> 16;
      const length = (lengthEntry & 0xffff) + (lengthExtra > 0 ? getBits(lengthExtra) : 0);
      const distanceEntry = DISTANCES[getCode(distances)] ?? 0;
      const distanceExtra = distanceEntry >> 16;
      const distance = (distanceEntry & 0xffff) + (distanceExtra > 0 ? getBits(distanceExtra) : 0);
      output?.copy(length, distance);
      made += length;
    }
  }
  watch.progress(made, at - start, tableEntries);
  return { made, data: output === null ? null : output.data };
}
