import { strToU8 } from "fflate";
import { describe, expect, it } from "vitest";
import { processEpub } from "../src";
import { ao3Epub, expectEpubError, zipEntries } from "./helpers";
import {
  dropOneFromCount,
  markEocd,
  renameEntry,
  withUnusedZip64Locator,
  withZip64Eocd,
  withZip64Extra,
} from "./zip-structure-fixtures";

const twoEntries = () => zipEntries({ "a.xml": "<p>x</p>", "b.xml": "<p>y</p>" });

describe("05 epub unzip limits: zip structure", () => {
  describe("File that is not a zip is rejected", () => {
    const real = ao3Epub();
    const junkAfter = new Uint8Array(real.length + 70_000);
    junkAfter.set(real);
    junkAfter.fill(0x41, real.length);
    const emptyZip = new Uint8Array(22);
    emptyZip.set([0x50, 0x4b, 0x05, 0x06]);

    it.each([
      ["empty input", new Uint8Array(0)],
      ["three bytes", strToU8("PK\x03")],
      ["a local header signature and then garbage", strToU8("PK\x03\x04 and then nothing")],
      ["an epub truncated by 30 bytes", real.slice(0, real.length - 30)],
      ["an epub followed by 70,000 junk bytes", junkAfter],
      ["an empty zip", emptyZip],
    ])("%s", async (_label, bytes) => {
      await expectEpubError(processEpub(bytes), "not_epub");
    });
  });

  describe("Entry name with .. is rejected", () => {
    it.each(["../../evil.xhtml", "../evil.xhtml", "a/../b.xhtml", "OEBPS/.."])(
      "%s",
      async (name) => {
        await expectEpubError(processEpub(zipEntries({ [name]: "<p>x</p>" })), "not_epub");
      },
    );

    it("when only the central directory copy of the name is unsafe", async () => {
      const zip = ao3Epub();
      expect(renameEntry(zip, "toc.ncx", "../.ncx", "central")).toBe(1);
      await expectEpubError(processEpub(zip), "not_epub");
    });

    it("but a name that merely contains two dots is accepted", async () => {
      const work = await processEpub(
        ao3Epub({ files: [{ name: "a..b/..c.xhtml", body: `<div id="chapters"><p>x</p></div>` }] }),
      );
      expect(work.chapters).toHaveLength(1);
    });
  });

  describe("Entry name with a leading slash is rejected", () => {
    it.each(["/etc/evil.xhtml", "//evil.xhtml", "/"])("%s", async (name) => {
      await expectEpubError(processEpub(zipEntries({ [name]: "<p>x</p>" })), "not_epub");
    });
  });

  describe("Entry name with a drive letter is rejected", () => {
    it.each(["C:\\evil.xhtml", "c:evil.xhtml", "z:/evil.xhtml"])("%s", async (name) => {
      await expectEpubError(processEpub(zipEntries({ [name]: "<p>x</p>" })), "not_epub");
    });
  });

  describe("Duplicate entry name is rejected", () => {
    it("when both headers of the second entry carry the first name", async () => {
      const zip = twoEntries();
      expect(renameEntry(zip, "b.xml", "a.xml")).toBe(2);
      await expectEpubError(processEpub(zip), "not_epub");
    });

    it("when only the central directory repeats a name", async () => {
      const zip = twoEntries();
      expect(renameEntry(zip, "b.xml", "a.xml", "central")).toBe(1);
      await expectEpubError(processEpub(zip), "not_epub");
    });

    it("when the repeated name is mimetype", async () => {
      const zip = zipEntries({ mimetypf: "x" });
      expect(renameEntry(zip, "mimetypf", "mimetype")).toBe(2);
      await expectEpubError(processEpub(zip), "not_epub");
    });
  });

  describe("Central directory that disagrees with the local headers is rejected", () => {
    it("when the central directory counts one entry fewer", async () => {
      const zip = ao3Epub();
      dropOneFromCount(zip);
      await expectEpubError(processEpub(zip), "not_epub");
    });

    it("when only the local header names a different entry", async () => {
      const zip = ao3Epub();
      expect(renameEntry(zip, "toc.ncx", "tox.ncx", "local")).toBe(1);
      await expectEpubError(processEpub(zip), "not_epub");
    });

    it("when the central directory names a different set of the same size", async () => {
      const zip = ao3Epub();
      expect(renameEntry(zip, "toc.ncx", "tox.ncx", "central")).toBe(1);
      expect(renameEntry(zip, "content.opf", "contenu.opf", "central")).toBe(1);
      await expectEpubError(processEpub(zip), "not_epub");
    });
  });

  describe("ZIP64 archive is rejected", () => {
    it.each(["count", "offset"] as const)(
      "when the EOCD %s field is at its maximum",
      async (field) => {
        await expectEpubError(processEpub(markEocd(ao3Epub(), field)), "not_epub");
      },
    );

    it("when a central entry carries a Zip64 extra field", async () => {
      await expectEpubError(processEpub(withZip64Extra(ao3Epub(), "toc.ncx")), "not_epub");
    });

    // The cases below also check the log message, so a fixture that breaks some other rule
    // (also `not_epub`) can't pass for the wrong reason.
    it("when a Zip64 extra field sits beside real sizes", async () => {
      const zip = withZip64Extra(ao3Epub(), "toc.ncx", { maxSizes: false });
      await expect(processEpub(zip)).rejects.toThrow(/ZIP64 archives are not supported/);
    });

    it("when the Zip64 extra field is not the first field", async () => {
      const zip = withZip64Extra(ao3Epub(), "toc.ncx", { maxSizes: false, after: 2 });
      await expect(processEpub(zip)).rejects.toThrow(/ZIP64 archives are not supported/);
    });

    it("when an extra field claims more bytes than the block holds", async () => {
      const zip = withZip64Extra(ao3Epub(), "toc.ncx", {
        maxSizes: false,
        after: 1,
        overrun: true,
      });
      await expect(processEpub(zip)).rejects.toThrow(/bad extra field/);
    });

    it("with a ZIP64 locator and real EOCD fields", async () => {
      await expect(processEpub(withUnusedZip64Locator(ao3Epub()))).rejects.toThrow(
        /ZIP64 archives are not supported/,
      );
    });

    it("with a ZIP64 EOCD record and locator", async () => {
      await expect(processEpub(withZip64Eocd(ao3Epub()))).rejects.toThrow(
        /ZIP64 archives are not supported/,
      );
    });
  });
});
