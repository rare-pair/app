import { strFromU8, unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { processEpub } from "../src";
import { ao3Epub, expectEpubError, zipEntries } from "./helpers";

// Scenario file: specs/scenarios/mvp/05-epub-unzip-limits.md. Package rules, all through processEpub.

/** A valid synthetic epub with some entries replaced (a null body deletes the entry). */
function withEntries(changes: Record<string, string | null>): Uint8Array {
  const { mimetype: _, ...rest } = unzipSync(ao3Epub());
  // oxlint-disable-next-line deslop/no-known-value-widening -- entries are replaced by name below
  const entries: Record<string, string | Uint8Array> = { ...rest };
  for (const [name, body] of Object.entries(changes)) {
    if (body === null) delete entries[name];
    else entries[name] = body;
  }
  return zipEntries(entries);
}

const entry = (name: string) => strFromU8(unzipSync(ao3Epub())[name]!);

describe("05-epub-unzip-limits: package rules", () => {
  describe("Wrong mimetype entry is rejected", () => {
    it.each([
      ["a different media type", "application/zip"],
      ["the right type in another case", "Application/EPUB+zip"],
      ["an empty entry", ""],
      ["text around the type", "x application/epub+zip"],
    ])("rejects %s", async (_label, mimetype) => {
      await expectEpubError(processEpub(ao3Epub({ mimetype })), "not_epub");
    });
  });

  describe("Missing mimetype entry is rejected", () => {
    it("rejects a zip with no mimetype entry", async () => {
      await expectEpubError(processEpub(ao3Epub({ mimetype: null })), "not_epub");
    });

    it("does not find a mimetype entry under another case", async () => {
      const { mimetype: _, ...rest } = unzipSync(ao3Epub());
      const bytes = zipEntries({ ...rest, Mimetype: "application/epub+zip" }, null);
      await expectEpubError(processEpub(bytes), "not_epub");
    });
  });

  describe("Missing container.xml is rejected", () => {
    const container = (fullPath: string) =>
      `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="${fullPath}" media-type="application/oebps-package+xml"/></rootfiles></container>`;

    it("rejects an epub with no META-INF/container.xml", async () => {
      await expectEpubError(
        processEpub(withEntries({ "META-INF/container.xml": null })),
        "not_epub",
      );
    });

    it("rejects a container.xml with no rootfile", async () => {
      const empty = `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles/></container>`;
      await expectEpubError(
        processEpub(withEntries({ "META-INF/container.xml": empty })),
        "not_epub",
      );
    });

    it.each(["../content.opf", "/content.opf"])(
      "rejects a rootfile path that leaves the zip: %s",
      async (fullPath) => {
        await expectEpubError(
          processEpub(withEntries({ "META-INF/container.xml": container(fullPath) })),
          "not_epub",
        );
      },
    );
  });

  describe("Missing OPF is rejected", () => {
    it("rejects an epub whose container.xml points to an OPF that isn't in the zip", async () => {
      await expectEpubError(processEpub(withEntries({ "content.opf": null })), "not_epub");
    });
  });

  describe("XML entity declarations are rejected", () => {
    const inject = (xml: string, keyword: string) =>
      xml.replace(/(<\?xml[^>]*\?>)/, `$1\n<!DOCTYPE x [<!${keyword} a "expanded">]>`);

    it.each([
      ["content.opf", "ENTITY"],
      ["content.opf", "entity"],
      ["toc.ncx", "ENTITY"],
      ["toc.ncx", "entity"],
      ["META-INF/container.xml", "ENTITY"],
    ])("rejects %s declaring <!%s", async (name, keyword) => {
      const bytes = withEntries({ [name]: inject(entry(name), keyword) });
      await expectEpubError(processEpub(bytes), "not_epub");
    });
  });

  describe("Malformed package XML is rejected as not_epub", () => {
    const damages: [string, (xml: string) => string][] = [
      ["truncated before the root closes", (xml) => xml.slice(0, xml.lastIndexOf("</"))],
      ["an end tag that matches no open tag", (xml) => xml.replace(/<\/[\w:]+>\s*$/, "</wrong>")],
      ["junk instead of XML", () => "not xml <<<"],
      ["an unterminated attribute quote", (xml) => xml.replace(/(<[a-z][^>]*? \w+="[^"]*)"/, "$1")],
      ["an unclosed inner element", (xml) => xml.replace(/<\/\w+>/, "")],
      ["a mismatched inner end tag", (xml) => xml.replace(/<\/(\w+)>/, "</x$1>")],
    ];

    it("still accepts whitespace before the XML declaration", async () => {
      const opf = `\n  ${entry("content.opf")}`;
      await expect(processEpub(withEntries({ "content.opf": opf }))).resolves.toBeDefined();
    });

    for (const name of ["META-INF/container.xml", "content.opf", "toc.ncx"])
      it.each(damages)(`rejects ${name}: %s`, async (_label, damage) => {
        const bytes = withEntries({ [name]: damage(entry(name)) });
        await expectEpubError(processEpub(bytes), "not_epub");
      });
  });

  describe("Passing the node budget is rejected as too large", () => {
    // One <br/> is one node. The budget is shared across documents. Parsing is slow
    // (about 85 microseconds a node in workerd), so these tests get a long timeout.
    const chapter = (name: string, units: number) => ({
      name,
      body: `<div>${"<br/>".repeat(units)}</div>`,
    });
    const slow = 150_000;

    it(
      "rejects an epub whose documents together hold more than 300,000 nodes",
      async () => {
        const bytes = ao3Epub({ files: [chapter("Synthetic_split_001.xhtml", 310_000)] });
        await expectEpubError(processEpub(bytes), "too_large");
      },
      slow,
    );

    it(
      "counts the budget across documents, not per document",
      async () => {
        // Each chapter is under the budget alone; together they pass it.
        const bytes = ao3Epub({
          files: [
            chapter("Synthetic_split_001.xhtml", 160_000),
            chapter("Synthetic_split_002.xhtml", 160_000),
          ],
        });
        await expectEpubError(processEpub(bytes), "too_large");
      },
      slow,
    );

    it("accepts documents that together stay under the budget", async () => {
      const bytes = ao3Epub({
        files: [
          chapter("Synthetic_split_001.xhtml", 20_000),
          chapter("Synthetic_split_002.xhtml", 20_000),
        ],
      });
      await expect(processEpub(bytes)).resolves.toBeDefined();
    });
  });

  describe("Nesting 256 deep or more fails to parse (was: more than 256)", () => {
    const nested = (depth: number) => ({
      name: "Synthetic_split_001.xhtml",
      body: `${"<div>".repeat(depth)}x${"</div>".repeat(depth)}`,
    });

    it("rejects a chapter nested 300 deep", async () => {
      await expectEpubError(processEpub(ao3Epub({ files: [nested(300)] })), "parse_failed");
    });

    // The template puts <html> and <body> above the chapter body, so 253 divs make
    // 255 levels (accepted) and 254 make 256 (rejected): the cap bites at 256 deep,
    // the root element being level 1.
    it("accepts a document 255 elements deep", async () => {
      const work = await processEpub(ao3Epub({ files: [nested(253)] }));
      // Preface, the one chapter, afterword.
      expect(work.chapters).toHaveLength(3);
    });

    it("rejects a document 256 elements deep", async () => {
      await expectEpubError(processEpub(ao3Epub({ files: [nested(254)] })), "parse_failed");
    });
  });
});
