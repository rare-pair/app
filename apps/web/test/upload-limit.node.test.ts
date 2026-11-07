import { describe, expect, it } from "vitest";
import { LIMITS } from "../../../packages/epub/src/unzip";
import { MAX_PDF_BYTES, MAX_UPLOAD_BYTES } from "../src/upload-limit";

// The web Worker restates the processor's input limit rather than bundle the
// processor to import it. This holds the two together, so that POST /uploads and
// ingest never disagree about a file at the boundary.
describe("02-upload-handshake", () => {
  it("Declared size limit is the processor's 25 MiB", () => {
    expect(MAX_UPLOAD_BYTES).toBe(26_214_400);
    expect(MAX_UPLOAD_BYTES).toBe(LIMITS.maxInputBytes);
  });

  it("12-pdf-upload: a PDF's declared size limit is the processor's 10 MiB", () => {
    expect(MAX_PDF_BYTES).toBe(10_485_760);
    expect(MAX_PDF_BYTES).toBe(LIMITS.maxPdfBytes);
  });
});
