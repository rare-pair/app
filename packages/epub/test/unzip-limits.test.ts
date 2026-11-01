import { describe, expect, it } from "vitest";
import { processEpub } from "../src";
import { expectEpubError, MiB } from "./helpers";
import {
  BASE_INFLATED,
  BASE_TOTAL,
  padded,
  patchHeaders,
  understate,
  withEntryCount,
} from "./zip-limits-fixtures";

// The code's "MB" is MiB (1,048,576 bytes), as for every other limit.
const TOTAL = 40 * MiB;
const ENTRY = 20 * MiB;

describe("05-epub-unzip-limits", () => {
  it("Valid AO3 epub passes the unzip checks", async () => {
    // A synthetic epub: real ones are ignored by the repo and absent in CI.
    const work = await processEpub(padded([]));
    expect(work.chapters).toHaveLength(1);
  });

  describe("Zip index is checked before anything is decompressed", () => {
    // Three padding entries whose central directory copies declare 20 MiB each
    // (60 MiB, each under the entry cap); their data and local headers stay tiny.
    function lyingIndex() {
      const zip = padded([1, 1, 1]);
      for (let i = 0; i < 3; i++) {
        expect(
          patchHeaders(zip, `pad${i}.xml`, (view, local, sizeAt) => {
            if (!local) view.setUint32(sizeAt, 20 * MiB, true);
          }),
        ).toBe(2);
      }
      return zip;
    }
    // Method 99 in a local header: inflating that entry fails as a corrupt entry.
    const breakLocalData = (zip: Uint8Array) =>
      patchHeaders(zip, "pad0.xml", (view, local, _size, nameAt) => {
        if (local) view.setUint16(nameAt - 22, 99, true);
      });

    it("rejects an index declaring more than 40 MB in total with zip_bomb", async () => {
      await expectEpubError(processEpub(lyingIndex()), "zip_bomb");
    });

    it("rejects it as zip_bomb even though inflating an entry would fail differently", async () => {
      const zip = padded([1, 1, 1]);
      // Control: with an honest index, the broken entry is reached and fails.
      expect(breakLocalData(zip)).toBe(2);
      await expectEpubError(processEpub(zip), "not_epub");

      const lying = lyingIndex();
      expect(breakLocalData(lying)).toBe(2);
      await expectEpubError(processEpub(lying), "zip_bomb");
    });
  });

  describe("entry count", () => {
    it("Exactly 2,000 entries is accepted", async () => {
      const work = await processEpub(withEntryCount(2_000));
      expect(work.chapters).toHaveLength(1);
    });

    it("More than 2,000 entries is rejected", async () => {
      await expectEpubError(processEpub(withEntryCount(2_001)), "zip_bomb");
    });
  });

  describe("total size", () => {
    // Two zero-filled pads bring the sum of every entry to the byte.
    const pads = (total: number) => [ENTRY, total - BASE_TOTAL - ENTRY];

    it("Exactly 40 MB uncompressed in total is accepted", async () => {
      const work = await processEpub(padded(pads(TOTAL)));
      expect(work.chapters).toHaveLength(1);
    });

    it("More than 40 MB uncompressed in total is rejected", async () => {
      await expectEpubError(processEpub(padded(pads(TOTAL + 1))), "zip_bomb");
    });

    it("rejects 42 MB inflated from a zip whose headers say 1 KiB", async () => {
      // Three 14 MiB entries (each under the entry cap) declaring 1 KiB: only the
      // byte count while inflating can catch the total.
      const zip = padded([14 * MiB, 14 * MiB, 14 * MiB]);
      for (let i = 0; i < 3; i++) expect(understate(zip, `pad${i}.xml`)).toBe(2);
      await expectEpubError(processEpub(zip), "zip_bomb");
    });

    it("counts the bytes of entries it inflates, to the byte, while inflating", async () => {
      // Headers say 1 KiB. The readable entries inflate to exactly 40 MiB (the
      // stylesheet is counted by the index but never inflated): accepted. One
      // byte more is rejected.
      const exact = [ENTRY, TOTAL - BASE_INFLATED - ENTRY];
      const zip = padded(exact);
      for (let i = 0; i < 2; i++) expect(understate(zip, `pad${i}.xml`)).toBe(2);
      const work = await processEpub(zip);
      expect(work.chapters).toHaveLength(1);

      const over = padded([ENTRY, exact[1]! + 1]);
      for (let i = 0; i < 2; i++) expect(understate(over, `pad${i}.xml`)).toBe(2);
      await expectEpubError(processEpub(over), "zip_bomb");
    });
  });

  describe("single entry", () => {
    it("Exactly 20 MB in one entry is accepted", async () => {
      const work = await processEpub(padded([ENTRY]));
      expect(work.chapters).toHaveLength(1);
    });

    it("More than 20 MB in one entry is rejected", async () => {
      await expectEpubError(processEpub(padded([ENTRY + 1])), "zip_bomb");
    });
  });

  describe("Zip that lies about its sizes is caught during decompression", () => {
    it("rejects an entry over 20 MB whose headers say 1 KiB", async () => {
      const zip = padded([ENTRY + 1]);
      expect(understate(zip, "pad0.xml")).toBe(2);
      await expectEpubError(processEpub(zip), "zip_bomb");
    });
  });
});
