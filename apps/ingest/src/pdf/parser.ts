import type { PdfParser } from "./index";

/** The parser, loaded by `import()`: this module and `unpdf` are for a PDF's job only. */
export const pdfParser = (): PdfParser => ({
  parse: async () => {
    throw new Error("not built");
  },
});
