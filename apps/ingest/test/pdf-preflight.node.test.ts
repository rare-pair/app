import { EpubError } from "@archive/epub";
import { zlibSync } from "fflate";
import { describe, expect, it } from "vitest";
import { PDF_LIMITS } from "../src/pdf/limits";
import { preflightPdf } from "../src/pdf/preflight";
import { buildPdf, flate, onePage, stream, type PdfBody } from "./pdf-builder";

/** The code `preflightPdf` refuses `bytes` with, or null when it lets the file through. */
function refusal(bytes: Uint8Array): string | null {
  try {
    preflightPdf(bytes);
    return null;
  } catch (error) {
    if (error instanceof EpubError) return error.code;
    throw error;
  }
}

const latin1 = (text: string) => Uint8Array.from(text, (c) => c.charCodeAt(0));

/** `bytes` of spaces, deflated: over the budget by a margin, in a few hundred KB. */
const spaces = (bytes: number) => zlibSync(new Uint8Array(bytes).fill(0x20), { level: 9 });
const OVER_BUDGET = PDF_LIMITS.maxInflatedBytes + 1024 * 1024;

const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

/** A file with `body` as an object beside the page's contents, which it doesn't name. */
const besidePage = (body: PdfBody): Uint8Array =>
  buildPdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Count 1 /Kids [3 0 R] >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>",
    flate("BT ET"),
    body,
  ]);

describe("12-pdf-upload: the checks before the parser opens a file", () => {
  describe("A stream that inflates too far is refused", () => {
    it("lets through a stream that inflates within the budget", () => {
      expect(refusal(onePage(flate("BT ET")))).toBeNull();
    });

    it("stops one stream that inflates past the budget", () => {
      expect(refusal(onePage(flate(new Uint8Array(OVER_BUDGET))))).toBe("zip_bomb");
    });

    it("adds up small streams that together pass the budget", () => {
      const part = flate(new Uint8Array(PDF_LIMITS.maxStreamInflatedBytes));
      const count = Math.ceil(OVER_BUDGET / PDF_LIMITS.maxStreamInflatedBytes);
      const bodies = Array.from({ length: count }, () => part);
      expect(refusal(buildPdf(bodies))).toBe("zip_bomb");
    });

    it("finds a stream whose /Length is false", () => {
      const data = spaces(OVER_BUDGET);
      const body = latin1(`<< /Filter /FlateDecode /Length 1 >>\nstream\n`);
      const whole = new Uint8Array(body.length + data.length);
      whole.set(body);
      whole.set(data, body.length);
      expect(refusal(onePage(whole))).toBe("zip_bomb");
    });

    it("finds a stream whose dictionary doesn't name its filter directly", () => {
      // `/Filter 5 0 R` is refused on its own, so this one hides behind a name nothing reads.
      const body = stream("/Subtype /Image", spaces(OVER_BUDGET));
      expect(refusal(onePage(body))).toBe("zip_bomb");
    });

    it("reads past the end of the keyword's line, as pdf.js does", () => {
      const data = spaces(OVER_BUDGET);
      const head = latin1(`<< /Filter /FlateDecode /Length ${data.length} >>\nstream junk\r\n`);
      const whole = new Uint8Array(head.length + data.length);
      whole.set(head);
      whole.set(data, head.length);
      expect(refusal(onePage(whole))).toBe("zip_bomb");
    });

    it("takes a header pdf.js takes and zlib doesn't: a window size over 32 KB", () => {
      const data = spaces(OVER_BUDGET);
      // CMF 0xF8 has a window nibble zlib refuses and pdf.js ignores; FLG makes FCHECK pass.
      data[0] = 0xf8;
      data[1] = 31 - ((0xf8 << 8) % 31);
      expect(refusal(onePage(stream("/Filter /FlateDecode", data)))).toBe("zip_bomb");
    });

    it("stops at the end of a stream's deflate data, whatever follows it", () => {
      // A final block, then bytes that would be an error if read as more blocks.
      const data = zlibSync(latin1("BT ET"));
      const trailing = new Uint8Array(data.length + 4096).fill(0xff);
      trailing.set(data);
      expect(refusal(onePage(stream("/Filter /FlateDecode", trailing)))).toBeNull();
    });

    it("refuses a stream whose deflate data is corrupt, since pdf.js is looser", () => {
      // Header, then a block type 3, which no deflate stream may hold.
      const data = Uint8Array.of(0x78, 0x9c, 0x07, 1, 2, 3, 4);
      expect(refusal(onePage(stream("/Filter /FlateDecode", data)))).toBe("pdf_unreadable");
    });

    it("refuses overlapping streams that make it read the file over and over", () => {
      // Each stored block holds the next "stream" keyword, so each stream runs to the file's end.
      const parts: number[] = [];
      for (let i = 0; i < 3_000; i++) {
        const chunk = latin1("\nstream\n");
        parts.push(0x78, 0x01, 0x00, chunk.length, 0x00, 0xff - chunk.length, 0xff, ...chunk);
      }
      const padded = new Uint8Array(4 * 1024 * 1024);
      padded.set(parts);
      const body = stream("/Filter /FlateDecode", padded);
      expect(refusal(onePage(body))).toBe("pdf_unreadable");
    });
  });

  describe("A filter that could hide a stream that inflates too far", () => {
    const bomb = spaces(OVER_BUDGET);
    const refused = {
      "a flate stream inside ASCIIHex": stream(
        "/Filter [/ASCIIHexDecode /FlateDecode]",
        `${hex(bomb)}>`,
      ),
      "the abbreviation, by the /F key": stream("/F [/AHx /Fl]", `${hex(bomb)}>`),
      "a name spelled in hex escapes": stream(
        "/Fil#74er [/ASCII#48exDecode /FlateDecode]",
        `${hex(bomb)}>`,
      ),
      "flate inside flate": flate(bomb, "/DecodeParms null /Filter [/FlateDecode /FlateDecode]"),
      LZW: stream("/Filter /LZWDecode", new Uint8Array(16)),
      "the LZW abbreviation": stream("/F /LZW", new Uint8Array(16)),
      RunLength: stream("/Filter /RunLengthDecode", new Uint8Array(16)),
      "a filter behind a reference": stream("/Filter 5 0 R", "x"),
      "a filter list holding a reference": stream("/Filter [5 0 R]", "x"),
      "a dictionary hidden by a string that closes it, to a naive reader": stream(
        "/X (>> stream ) /Filter /LZWDecode",
        new Uint8Array(16),
      ),
      "a dictionary with a comment": stream("%>>\n/Filter /LZWDecode", new Uint8Array(16)),
    };
    for (const [name, body] of Object.entries(refused)) {
      it(`refuses ${name}`, () => {
        expect(["pdf_unreadable", "zip_bomb"]).toContain(refusal(onePage(body)));
      });
    }

    it("refuses a stream only another object's offset reaches, inside a stream's data", () => {
      const hidden = latin1(
        "9 0 obj\n<< /Filter /LZWDecode /Length 4 >>\nstream\nabcd\nendstream\n",
      );
      expect(refusal(onePage(stream("", hidden)))).toBe("pdf_unreadable");
    });

    it("lets through what real files use: flate, images, and flate over an image", () => {
      for (const body of [
        stream("", "BT ET"),
        flate("BT ET", "/DecodeParms << /Predictor 12 /Columns 4 >>"),
        flate("x", "/Other [/FlateDecode /DCTDecode]"),
        stream("/Subtype /Image /Filter /DCTDecode", Uint8Array.of(0xff, 0xd8, 0xff)),
        stream("/Subtype /Image /Filter [/DCTDecode]", Uint8Array.of(0xff, 0xd8, 0xff)),
        stream("/Subtype /Image /Filter /JPXDecode", "x"),
        flate("x", "/Subtype /Image /Other 1"),
      ]) {
        expect(refusal(besidePage(body))).toBeNull();
      }
    });
  });

  describe("A structure that makes the parser decode a stream over and over", () => {
    const page = (contents: string) =>
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${contents} >>`;
    const pdfWith = (contents: string, ...more: PdfBody[]) =>
      buildPdf([
        "<< /Type /Catalog /Pages 2 0 R >>",
        "<< /Type /Pages /Count 1 /Kids [3 0 R] >>",
        page(contents),
        flate("BT ET"),
        flate("BT ET"),
        ...more,
      ]);

    it("refuses a /Contents array that repeats a reference", () => {
      expect(refusal(pdfWith("[4 0 R 4 0 R]"))).toBe("pdf_unreadable");
    });

    it("refuses a /Contents array of more than a few entries", () => {
      const entries = Array.from(
        { length: PDF_LIMITS.maxContentsEntries + 1 },
        (_, i) => `${i + 10} 0 R`,
      );
      expect(refusal(pdfWith(`[${entries.join(" ")}]`))).toBe("pdf_unreadable");
    });

    it("takes a /Contents array of a few different streams", () => {
      expect(refusal(pdfWith("[4 0 R 5 0 R]"))).toBeNull();
    });

    it("refuses a /Contents array whose streams together inflate too far", () => {
      const part = flate(new Uint8Array(PDF_LIMITS.maxStreamInflatedBytes - 1024));
      expect(refusal(pdfWith("[6 0 R 7 0 R]", part, part))).toBe("pdf_unreadable");
    });

    it("refuses /Contents that points at an array object", () => {
      expect(refusal(pdfWith("6 0 R", "[4 0 R 4 0 R]"))).toBe("pdf_unreadable");
    });

    it("refuses a repeated reference in a page inside an object stream", () => {
      const objects = "3 0 << /Contents [4 0 R 4 0 R] >>";
      const body = flate(objects, "/Type /ObjStm /N 1 /First 4");
      expect(refusal(pdfWith("4 0 R", body))).toBe("pdf_unreadable");
    });

    it("refuses /Contents that points at an array in an object stream", () => {
      const objects = "7 0 [4 0 R 4 0 R]";
      const body = flate(objects, "/Type /ObjStm /N 1 /First 4");
      expect(refusal(pdfWith("7 0 R", body))).toBe("pdf_unreadable");
    });

    it("takes /Contents that points at a stream, and an annotation's /Contents string", () => {
      expect(refusal(pdfWith("4 0 R", "<< /Subtype /Link /Contents (a note) >>"))).toBeNull();
    });

    it("refuses a form XObject", () => {
      const form = stream("/Type /XObject /Subtype /Form /BBox [0 0 9 9]", "x");
      expect(refusal(onePage(form))).toBe("pdf_unreadable");
    });

    it("refuses a form XObject named in hex escapes", () => {
      expect(refusal(onePage(stream("/Sub#74ype /F#6Frm", "x")))).toBe("pdf_unreadable");
    });

    it("refuses a stream's subtype behind a reference, which could be a form", () => {
      expect(refusal(onePage(stream("/Subtype 5 0 R", "x")))).toBe("pdf_unreadable");
    });

    it("takes an image and a font file", () => {
      expect(refusal(besidePage(stream("/Subtype /Image /Filter /DCTDecode", "x")))).toBeNull();
      expect(refusal(besidePage(flate("x", "/Subtype /Type1C")))).toBeNull();
    });
  });

  describe("Review round 1: what pdf.js reads and a naive scan wouldn't", () => {
    const pdfWith = (contents: string, ...more: PdfBody[]) =>
      buildPdf([
        "<< /Type /Catalog /Pages 2 0 R >>",
        "<< /Type /Pages /Count 1 /Kids [3 0 R] >>",
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${contents} >>`,
        flate("BT ET"),
        flate("BT ET"),
        ...more,
      ]);
    const raw = (dict: string, data = "x") => latin1(`${dict}\nstream\n${data}\nendstream`);

    it("reads a dictionary whose first token isn't a name, as pdf.js skips one token", () => {
      expect(refusal(onePage(raw("<<[/Subtype/Form/BBox[0 0 9 9]/Length 1]>>")))).toBe(
        "pdf_unreadable",
      );
      expect(refusal(onePage(raw("<<[/Filter/AHx/Length 1]>>")))).toBe("pdf_unreadable");
    });

    it("reads on past a >> that is a key's value, as pdf.js does", () => {
      expect(refusal(onePage(raw("<</Q>>/Subtype/Form/BBox[0 0 9 9]/Length 1>>")))).toBe(
        "pdf_unreadable",
      );
    });

    it("refuses a stream inside an object stream", () => {
      const inner = "5 0 <</Subtype/Image/Length 1>>\nstream\nx\nendstream";
      const body = flate(inner, "/Type /ObjStm /N 1 /First 4");
      expect(refusal(pdfWith("4 0 R", body))).toBe("pdf_unreadable");
    });

    it("refuses an image filter on a stream that isn't an image", () => {
      expect(refusal(onePage(stream("/Filter /DCTDecode", "x")))).toBe("pdf_unreadable");
    });

    it("refuses /Contents that names a stream with an image filter", () => {
      const image = stream("/Subtype /Image /Filter /DCTDecode", "x");
      expect(refusal(pdfWith("6 0 R", image))).toBe("pdf_unreadable");
      expect(refusal(pdfWith("[4 0 R 6 0 R]", image))).toBe("pdf_unreadable");
    });

    it("refuses the filters a text PDF has no use for, whose decoders have no budget", () => {
      for (const filter of ["CCF", "CCITTFaxDecode", "JBIG2Decode"]) {
        expect(refusal(onePage(stream(`/Subtype /Image /Filter /${filter}`, "x"))), filter).toBe(
          "pdf_unreadable",
        );
      }
    });

    it("reads numbers as pdf.js does: signs, decimals, and a keyword right after", () => {
      for (const list of ["[+4 0 R +4 0 R]", "[4.0 0 R 4.0 0 R]", "[4 0R 4 0R]"]) {
        expect(refusal(pdfWith(list)), list).toBe("pdf_unreadable");
      }
      expect(refusal(onePage(flate("x"), { trailerExtra: "/Size +200000" }))).toBe(
        "pdf_unreadable",
      );
    });

    it("takes a harmless list that isn't references, and finds references after junk", () => {
      expect(refusal(pdfWith("[1 4 0 R 4 0 R]"))).toBe("pdf_unreadable");
    });

    it("reads an object stream with no /Type, by its /First and /N", () => {
      const body = flate("3 0 << /Contents [4 0 R 4 0 R] >>", "/N 1 /First 4");
      expect(refusal(pdfWith("4 0 R", body))).toBe("pdf_unreadable");
    });

    it("reads an object stream with no filter", () => {
      const body = stream("/Type /ObjStm /N 1 /First 4", "3 0 << /Contents [4 0 R 4 0 R] >>");
      expect(refusal(pdfWith("4 0 R", body))).toBe("pdf_unreadable");
    });

    it("refuses an object stream whose /N or /First is behind a reference", () => {
      const body = flate("3 0 << /Contents [4 0 R 4 0 R] >>", "/Type /ObjStm /N 7 0 R /First 4");
      expect(refusal(pdfWith("4 0 R", body))).toBe("pdf_unreadable");
    });

    it("refuses an object stream with a filter it can't read", () => {
      const body = stream("/Type /ObjStm /N 1 /First 4 /Subtype /Image /Filter /DCTDecode", "x");
      expect(refusal(pdfWith("4 0 R", body))).toBe("pdf_unreadable");
    });

    it("isn't quadratic on stream keywords with no line end", () => {
      const file = latin1(
        `%PDF-1.7\n${"stream ".repeat(1_000_000)}\nxref\n0 0\ntrailer\n<<>>\nstartxref\n`,
      );
      const tail = latin1(`${file.length - 34}\n%%EOF\n`);
      const whole = new Uint8Array(file.length + tail.length);
      whole.set(file);
      whole.set(tail, file.length);
      const started = Date.now();
      expect(refusal(whole)).toBe("pdf_unreadable");
      expect(Date.now() - started).toBeLessThan(5_000);
    });

    it("refuses nesting too deep to read, as a final refusal", () => {
      const file = onePage(`<</A${"[".repeat(200_000)}`);
      expect(refusal(file)).toBe("pdf_unreadable");
    });

    it("doesn't keep the values of keys it has no use for", () => {
      // 10 MB of numbers held as objects would be some hundreds of MB; a scan that keeps them
      // would pass here but fail on Cloudflare, so this holds the shape: a very long list passes.
      const file = besidePage(`<</A[${"0 ".repeat(5_000_000)}]>>`);
      expect(refusal(file)).toBeNull();
    });

    it("refuses an implausibly long list under a key it reads", () => {
      const stm = onePage(stream(`/Type/XRef/Size 5/Index[${"1 ".repeat(5_000)}]`, "x"));
      expect(refusal(stm)).toBe("pdf_unreadable");
    });
  });

  describe("The budgets", () => {
    it("refuses one stream past the per-stream cap", () => {
      const body = flate(new Uint8Array(PDF_LIMITS.maxStreamInflatedBytes + 1024));
      expect(refusal(onePage(body))).toBe("zip_bomb");
    });

    it("takes a stream at the per-stream cap", () => {
      const body = flate(new Uint8Array(PDF_LIMITS.maxStreamInflatedBytes));
      expect(refusal(onePage(body))).toBeNull();
    });

    it("leaves room for a real 10 MB file: 10 MB at docs-sample's 8.1:1 is 81 MB", () => {
      expect(PDF_LIMITS.maxInflatedBytes).toBeGreaterThan(81 * 1024 * 1024);
    });
  });

  describe("Encrypted and corrupt files are refused", () => {
    it("refuses a trailer with /Encrypt", () => {
      const file = onePage(flate("x"), { trailerExtra: "/Encrypt 4 0 R" });
      expect(refusal(file)).toBe("pdf_unreadable");
    });

    it("refuses /Encrypt in hex escapes", () => {
      const file = onePage(flate("x"), { trailerExtra: "/Enc#72ypt 4 0 R" });
      expect(refusal(file)).toBe("pdf_unreadable");
    });

    it("refuses /Encrypt in a cross-reference stream's dictionary", () => {
      const file = onePage(stream("/Type /XRef /Size 5 /Encrypt 4 0 R", "x"));
      expect(refusal(file)).toBe("pdf_unreadable");
    });

    it("refuses a truncated file", () => {
      const file = onePage(flate("x"));
      expect(refusal(file.subarray(0, file.length - 40))).toBe("pdf_unreadable");
    });

    it("refuses a startxref past the end of the file", () => {
      expect(refusal(onePage(flate("x"), { startxref: 99_999_999 }))).toBe("pdf_unreadable");
    });

    it("refuses a startxref that lands on neither xref nor an object", () => {
      expect(refusal(onePage(flate("x"), { startxref: 3 }))).toBe("pdf_unreadable");
    });

    it("takes a startxref that lands on a cross-reference stream's object", () => {
      const file = onePage(flate("x"));
      const text = String.fromCharCode(...file);
      const at = text.indexOf("4 0 obj");
      expect(refusal(onePage(flate("x"), { startxref: at }))).toBeNull();
    });
  });

  describe("Too many objects or pages are refused", () => {
    it("refuses a trailer /Size over 100,000", () => {
      expect(refusal(onePage(flate("x"), { size: 100_001 }))).toBe("pdf_unreadable");
    });

    it("takes a trailer /Size of 100,000", () => {
      expect(refusal(onePage(flate("x"), { size: 100_000 }))).toBeNull();
    });

    it("refuses a cross-reference stream whose /Size is over 100,000", () => {
      const file = onePage(stream("/Type /XRef /Size 100001", "x"));
      expect(refusal(file)).toBe("pdf_unreadable");
    });

    it("refuses a false /Size over more objects than 100,000", () => {
      const bodies = Array.from({ length: 100_001 }, () => "null");
      expect(refusal(buildPdf(bodies, { size: 5 }))).toBe("pdf_unreadable");
    });

    it("refuses object streams that claim over 100,000 objects", () => {
      const file = onePage(flate("x", "/Type /ObjStm /N 100001 /First 1"));
      expect(refusal(file)).toBe("pdf_unreadable");
    });

    it("refuses a false /Size over a longer cross-reference table", () => {
      const entries = "0000000000 00000 n \n".repeat(100_001);
      const file = latin1(
        `%PDF-1.7\n1 0 obj\nnull\nendobj\nxref\n0 100001\n${entries}trailer\n<< /Size 2 /Root 1 0 R >>\nstartxref\n`,
      );
      const tail = latin1(`${"%PDF-1.7\n1 0 obj\nnull\nendobj\n".length}\n%%EOF\n`);
      const whole = new Uint8Array(file.length + tail.length);
      whole.set(file);
      whole.set(tail, file.length);
      expect(refusal(whole)).toBe("pdf_unreadable");
    });

    it("refuses a cross-reference stream whose /Index claims over 100,000 entries", () => {
      const file = onePage(stream("/Type /XRef /Size 5 /Index [0 100001]", "x"));
      expect(refusal(file)).toBe("pdf_unreadable");
    });
  });
});
