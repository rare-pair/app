// Synthetic PDFs for the tests, built by hand: no fic text, and nothing from a real file. Runs in
// Node and in workerd.
import { zlibSync } from "fflate";

const encoder = new TextEncoder();
const latin1 = (text: string) => Uint8Array.from(text, (c) => c.charCodeAt(0));

const join = (parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
};

/** One object's body: text, or bytes for a body that holds a binary stream. */
export type PdfBody = string | Uint8Array;

/** A stream object's body: `dict` is what goes in the dictionary, beside a correct `/Length`. */
export const stream = (dict: string, data: Uint8Array | string): Uint8Array => {
  const bytes = typeof data === "string" ? latin1(data) : data;
  return join([
    encoder.encode(`<< ${dict} /Length ${bytes.length} >>\nstream\n`),
    bytes,
    encoder.encode("\nendstream"),
  ]);
};

/** A stream of `data` deflated, as `/FlateDecode` holds it. */
export const flate = (data: Uint8Array | string, dict = ""): Uint8Array =>
  stream(
    `/Filter /FlateDecode ${dict}`,
    zlibSync(typeof data === "string" ? latin1(data) : data, { level: 6 }),
  );

export interface BuildOptions {
  /** More entries for the trailer: `/Encrypt 4 0 R`, say. */
  trailerExtra?: string;
  /** The trailer's `/Size`, when not the true one. */
  size?: number;
  /** The `startxref` offset, when not the true one. */
  startxref?: number;
}

/** The file for `bodies`, where `bodies[i]` is object `i + 1`, with a correct cross-reference table. */
export function buildPdf(bodies: PdfBody[], options: BuildOptions = {}): Uint8Array {
  const header = encoder.encode("%PDF-1.7\n");
  const parts = [header];
  const offsets: number[] = [];
  let at = header.length;
  bodies.forEach((body, i) => {
    const object = join([
      encoder.encode(`${i + 1} 0 obj\n`),
      typeof body === "string" ? encoder.encode(body) : body,
      encoder.encode("\nendobj\n"),
    ]);
    offsets.push(at);
    parts.push(object);
    at += object.length;
  });
  const lines = ["xref", `0 ${bodies.length + 1}`, "0000000000 65535 f "];
  for (const offset of offsets) lines.push(`${String(offset).padStart(10, "0")} 00000 n `);
  const size = options.size ?? bodies.length + 1;
  const tail =
    `${lines.join("\n")}\ntrailer\n<< /Size ${size} /Root 1 0 R ${options.trailerExtra ?? ""} >>\n` +
    `startxref\n${options.startxref ?? at}\n%%EOF\n`;
  parts.push(encoder.encode(tail));
  return join(parts);
}

/** A catalog, a page tree and one page whose contents are object 4, `content`. */
export const onePage = (content: PdfBody, options: BuildOptions = {}): Uint8Array =>
  buildPdf(
    [
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Count 1 /Kids [3 0 R] >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>",
      content,
    ],
    options,
  );
