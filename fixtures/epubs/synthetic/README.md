# Synthetic epub fixtures (committed)

Unlike the real fixtures one folder up, these are meant to be committed. They are
AO3-shaped epubs with numbered filler text and no fanwork in them, so the
`packages/epub` fixture tests run everywhere, CI included, with no real epubs present.

`packages/epub/scripts/synthetic-fixtures.ts` writes every file here, `expected.json`
included. Don't edit them by hand: change the script and run

    npm run fixtures:synthetic -w @archive/epub

The output is the same byte for byte on every run, so a diff here means the script
changed. Commit both together.

| File | Covers |
| --- | --- |
| `synthetic-one-shot-01.epub` | One-shot with a relationship and characters; has an `expected.json` entry |
| `synthetic-one-shot-02-anonymous.epub` | Anonymous one-shot (byline with no profile link); has an `expected.json` entry |
| `synthetic-multi-chapter-01.epub` | Three chapters over two files, one chapter split across both; a series member |
| `synthetic-images-01.epub` | A one-shot with a PNG in the manifest |
| `synthetic-rtl-01.epub` | Right-to-left, non-English text |

The files without an entry get the generic checks only: they parse, the output is
deterministic, and the HTML is sanitized. Names start with `synthetic-` so they never
clash with a real fixture's; the test setup fails if one does.
