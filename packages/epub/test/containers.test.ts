import { strFromU8, strToU8, unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { processEpub } from "../src";
import { ao3Epub, expectEpubError, MiB, zipEntries } from "./helpers";

/**
 * Calls `patch` on the local header and the central directory entry for
 * `name` (with the offsets of their uncompressed size and name); returns how
 * many headers it found.
 */
function patchHeaders(
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

describe("hostile containers", () => {
  it("accepts the synthetic baseline", async () => {
    const work = await processEpub(ao3Epub());
    expect(work.ao3WorkId).toBe("1000001");
    expect(work.chapters).toHaveLength(1);
  });

  it("rejects a file that is not a zip", async () => {
    await expectEpubError(processEpub(strToU8("just some text, not a zip")), "not_epub");
  });

  it("rejects a wrong mimetype", async () => {
    await expectEpubError(processEpub(ao3Epub({ mimetype: "application/zip" })), "not_epub");
  });

  it("rejects a missing mimetype", async () => {
    await expectEpubError(processEpub(ao3Epub({ mimetype: null })), "not_epub");
  });

  it.each([
    "../evil.xhtml",
    "OEBPS/../../evil.xhtml",
    "/etc/evil.xhtml",
    "C:/evil.xhtml",
    "OEBPS\\evil.xhtml",
  ])("rejects the entry name %s", async (name) => {
    await expectEpubError(processEpub(zipEntries({ [name]: "<p>x</p>" })), "not_epub");
  });

  it("rejects an entry that inflates past 20 MB (30 MB of zeros)", async () => {
    await expectEpubError(
      processEpub(zipEntries({ "big.bin": new Uint8Array(30 * MiB) })),
      "zip_bomb",
    );
  });

  it("rejects an entry that inflates past 20 MB while declaring a small size", async () => {
    // Both headers declare 1 KiB, so only the streaming byte count can catch it.
    const zip = zipEntries({ "big.xhtml": new Uint8Array(30 * MiB) });
    expect(
      patchHeaders(zip, "big.xhtml", (view, local, size) => view.setUint32(size, 1024, true)),
    ).toBe(2);
    await expectEpubError(processEpub(zip), "zip_bomb");
  });

  it("rejects a central directory that names a different entry than the local header", async () => {
    const zip = ao3Epub();
    // Central directory only: "toc.ncx" becomes "tox.ncx".
    expect(
      patchHeaders(
        zip,
        "toc.ncx",
        (view, local, _size, nameAt) => local || view.setUint8(nameAt + 2, 0x78),
      ),
    ).toBe(2);
    await expectEpubError(processEpub(zip), "not_epub");
  });

  it("rejects an archive that declares more than 40 MB in total", async () => {
    const chunk = new Uint8Array(19 * MiB);
    const entries: Record<string, Uint8Array> = {};
    for (let i = 0; i < 3; i++) entries[`part${i}.bin`] = chunk;
    await expectEpubError(processEpub(zipEntries(entries)), "zip_bomb");
  });

  it("rejects more than 2,000 entries", async () => {
    const entries: Record<string, string> = {};
    for (let i = 0; i < 2_000; i++) entries[`f${i}.txt`] = "x";
    // Plus the mimetype entry: 2,001 in all.
    await expectEpubError(processEpub(zipEntries(entries)), "zip_bomb");
  });

  it("accepts a non-ASCII entry name whose UTF-8 flag is set in only one header", async () => {
    const name = "作品_split_001.xhtml";
    const zip = ao3Epub({ files: [{ name, body: `<div id="chapters"><p>marker-utf8</p></div>` }] });
    // Clear bit 11 (UTF-8) of the central directory entry's flags only.
    const cleared = patchHeaders(zip, name, (view, local, _size, nameAt) => {
      if (!local) view.setUint16(nameAt - 38, view.getUint16(nameAt - 38, true) & ~0x800, true);
    });
    expect(cleared).toBe(2);
    const work = await processEpub(zip);
    expect(work.chapters[0]!.html).toContain("marker-utf8");
  });

  it("flags a manifest image the unzipper does not read", async () => {
    const work = await processEpub(
      ao3Epub({ extraManifest: [{ href: "images/p.bmp", mediaType: "image/bmp", data: "BM" }] }),
    );
    expect(work.reviewReasons).toEqual(["unread_manifest_item: images/p.bmp"]);
  });

  it("flags a spine itemref with no manifest item", async () => {
    const files = unzipSync(ao3Epub());
    const opf = strFromU8(files["content.opf"]!).replace(
      "</spine>",
      `<itemref idref="ghost"/></spine>`,
    );
    const { mimetype: _, ...rest } = files;
    const work = await processEpub(zipEntries({ ...rest, "content.opf": opf }));
    expect(work.reviewReasons).toEqual(['unknown_spine_item: "ghost"']);
  });

  it("rejects input over 25 MB before unzipping", async () => {
    const bytes = new Uint8Array(25 * MiB + 1);
    bytes.set([0x50, 0x4b, 0x03, 0x04]);
    await expectEpubError(processEpub(bytes), "too_large");
  });

  it("rejects a valid epub without an AO3 work URL", async () => {
    await expectEpubError(processEpub(ao3Epub({ workId: null })), "not_ao3");
  });

  it("rejects a non-native file that only has an AO3 URL in the OPF", async () => {
    const bytes = zipEntries({
      "META-INF/container.xml": `<container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>`,
      "OEBPS/content.opf": `<package xmlns="http://www.idpf.org/2007/opf" version="2.0">
        <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
          <dc:title>Elsewhere</dc:title><dc:creator>someone</dc:creator>
          <dc:source>http://archiveofourown.org/works/5</dc:source>
        </metadata>
        <manifest><item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/></manifest>
        <spine><itemref idref="c1"/></spine>
      </package>`,
      "OEBPS/c1.xhtml": `<html><body><p>plain text</p></body></html>`,
    });
    await expectEpubError(processEpub(bytes), "not_ao3");
  });

  it("rejects a missing OPF", async () => {
    const bytes = zipEntries({
      "META-INF/container.xml": `<container><rootfiles><rootfile full-path="nope.opf"/></rootfiles></container>`,
    });
    await expectEpubError(processEpub(bytes), "not_epub");
  });

  it("refuses XML entity declarations", async () => {
    const bytes = zipEntries({
      "META-INF/container.xml": `<?xml version="1.0"?><!DOCTYPE c [<!ENTITY a "aaaaaaaa">]><container>&a;</container>`,
    });
    await expectEpubError(processEpub(bytes), "not_epub");
  });
});
