# Scenario: Upload a PDF of an AO3 work

Relates to: docs/ARCHITECTURE.md § Ingestion pipeline, § Dedupe, § Reading (Download original epub), § The re-sanitize backfill; docs/FRONTEND-DISCOVERY.md § Key journeys (3); specs/scenarios/mvp/02-upload-handshake.md; specs/scenarios/mvp/06-ao3-preface-and-chapters.md; specs/scenarios/mvp/08-versioning-and-dedupe.md; specs/scenarios/mvp/09-content-origin.md

Status: built. Some readers only saved a PDF, and with the original archive offline they can't get an epub. This accepts those files, narrowly, and accepts that the result reads less well than an epub. An epub that isn't older wins over a PDF, and a PDF only replaces an epub if a moderator makes it current.

## What the tests showed

From throwaway tests on 2026-11-07 of 8 PDFs: 2 AO3 exports or copies of them, 4 browser prints of AO3's HTML download, and 2 Calibre conversions of epubs. The numbers are recorded here because the test folder doesn't last. They were run in Node and in local workerd, not on Cloudflare.

- **What survives:** the work ID, tags and authors from link annotations, and the printed "Posted originally" URL, which agreed with the link in 8 of 8. The chapter count matched the declared count in 8 of 8. The 2 Calibre conversions matched their epubs on all 26 compared fields, and on words within 0.1%.
- **What doesn't survive exactly:** paragraphs are off by 5 to 19%. Italics need `getOperatorList()`, which took +275 MB on a 335-page file, so they're left out here. One sample, broker-03, holds 2 image objects; the rest hold none, and no test has checked what becomes of an image.
- **Cost:** 2.3 s and +46 MB for the largest real file, text only. 9.1 s and +95 MB for a synthetic 25 MB file. `unpdf` adds 1.66 MB to the bundle. Local workerd enforces no CPU limit, so production's cost is unknown.
- **Hostile files:** a 50,000-page file doesn't finish in 60 s. A 261 KB file that inflates to 256 MB took +455 MB, with nothing visible before inflating.
- **What a budget on each stream doesn't catch (2026-11-07, in workerd, measured as process RSS):** pdf.js decodes a stream once per reference. A 13 KB file with one 1 MiB stream named 2,000 times in `/Contents` took 6.1 GB, and a 16 KB file with one 15 MiB stream named 64 times took 2.9 GB. A 2.4 KB file of form XObjects calling each other took +150 MB, with no Flate at all. None of the 6 samples or 2 fresh Calibre conversions (Calibre 8.10, default settings) uses a form XObject or a `/Contents` array, and all 8 pass every check here. The largest stream in any of them inflates to 0.24 MB, and the most any inflates in all is 46 MB, from the 5.7 MB docs-sample.
- **Memory with the checks:** the 256 MB file is refused in 4 ms at +7 MB, since the check counts what a stream makes without keeping it, and the two repeated-reference files in 2 ms at +6 MB or less. A 26 MB file (over today's limit) needed about 97 MB by V8's heap limit plus its file copies, which is why a PDF is limited to 10 MB. That's an estimate from local workerd, and only Cloudflare can settle it.

Only 2 of the 8 could be checked against an epub, and both are single-chapter. So chapter text comparison, tags from print and paragraphs are unverified for multi-chapter files, and memory is tight, so a PDF is limited to 10 MB. See "Before it ships".

## Setup

- Fixtures are synthetic PDFs built by a script in the tests, holding no fic text. Real PDFs stay on the operator's machine under `fixtures/`, and `fixtures/**/*.pdf` is git-ignored
- A file is a PDF because of its bytes, not its name or the type it was sent with
- A PDF is limited to 10 MB, and an epub keeps its 25 MB (operator's ruling, 2026-11-07). The daily quota, Turnstile and the rate limits are the same as for an epub, and a PDF counts as one upload
- A **PDF version** is a work version made from a PDF. It carries the review reason `from_pdf`, so it goes live with the existing notice, and it never holds an upload by itself
- An upload's `format` column says `epub` or `pdf`, set when it's ingested. Its original is stored at `originals/<upload id>.epub` or `originals/<upload id>.pdf`, and every reader of that key goes through one helper that takes the format
- `pdf_unreadable` is a new upload status: in the `UploadStatus` type, the database check, the status labels and messages, and an error code ingest treats as final, so the job isn't retried

## Cases

### Uploading

#### The upload page takes PDFs
- GIVEN a signed-in uploader on the upload page
- WHEN they pick or drop a `.pdf` file
- THEN it joins the list like an epub, goes through the same `POST /uploads`, `PUT` and confirm, and shows its own status on `/me/uploads`
- AND `PUT` accepts exactly `application/epub+zip` or `application/pdf`, and the page sends whichever the file's extension calls for. Any other type is still a 415, and spec 02 says so
- AND the page's wording says PDFs are accepted, and that an epub reads better if they have one

#### A PDF over 10 MB is refused in plain words
- GIVEN a PDF over 10 MB
- WHEN the page lists it, or it's declared at `POST /uploads` with the PDF type, or sent to `PUT` with the PDF type
- THEN the page shows it can't be sent, and the Worker answers 413, saying it's over the 10 MB limit for a PDF
- AND an epub of the same size is taken, up to its 25 MB
- AND a PDF sent as an epub ends `too_large` at ingest, by its bytes, and the message on `/me/uploads` gives both limits

#### A file's bytes decide what it is
- GIVEN a PDF named `.epub`, or an epub named `.pdf`
- WHEN it is ingested
- THEN it goes through the processor its bytes call for
- AND a file that starts `%PDF-` goes to the PDF processor. Anything else goes to the epub processor, so random bytes named `.pdf` end `not_epub`, whose message says it isn't a valid EPUB or PDF

#### A zip doesn't hold PDFs yet
- GIVEN a zip of epubs and PDFs on the upload page (specs/scenarios/mvp/26-bulk-zip-upload.md)
- WHEN it is added to the list
- THEN the epubs are added, and each PDF is shown as skipped

### Which files are accepted

#### A PDF of an AO3 work is accepted
- GIVEN a PDF with the printed "Posted originally on the Archive of Our Own" line and its work URL, whichever tool made it: AO3's own export, or a browser's or a word processor's copy of one
- WHEN it is ingested
- THEN it becomes a live version of that work, with its metadata and chapters

#### A PDF with no such line is refused
- GIVEN a PDF with no "Posted originally" line, even if a work link appears elsewhere
- WHEN it is ingested
- THEN it ends `not_ao3`, as an epub does, and its file is treated as a refused epub's is

#### A printed URL and a link that disagree are looked at
- GIVEN a PDF whose printed work URL and link annotation name different works
- WHEN it is ingested
- THEN the printed one is used, and the version gets the `work_id_mismatch` review reason, as an epub does

#### Tags come from links, then from print
- GIVEN a PDF with link annotations on its tags, or one with none
- WHEN it is ingested
- THEN each tag's field comes from its link and the label before it, deduped by URL
- AND with no links, the printed fields are used, and the version gets the `tags_from_print` review reason, because a tag holding ", " can't be told apart from two tags

#### An anonymous work has no author link
- GIVEN a PDF whose byline is the anonymous marker
- WHEN it is ingested
- THEN it is stored as an epub's anonymous work is
- AND a `/users/` link outside the byline isn't taken for an author
- AND only the marker alone is anonymous: "by Anonymous, A Name" names both, with `byline_ambiguous`, for the opt-out check to read
- AND a PDF's document metadata isn't read for authors, since a browser or word processor can set it to anything, so a file with no byline has `byline_missing`

#### The chapter count must match
- GIVEN a PDF whose chapters can't be found in the number its `Chapters:` line declares
- WHEN it is ingested
- THEN it is refused with `pdf_unreadable`, whose message says the chapters couldn't be told apart and that an epub would work

#### A work with one chapter has nothing to split
- GIVEN a PDF declaring one chapter, or with no `Chapters:` line, which counts as one
- WHEN it is ingested
- THEN everything between the preface and the afterword is its chapter

### Hostile files

Each stops before the parser opens the file, or stops it within its budget. The job ends with no retry, and its file is treated as a refused epub's is.

These checks don't bound everything the parser can do, and that's accepted (operator's ruling, 2026-11-07): a file that passes them and still kills the isolate gets the normal retries, then ends `parse_failed`, as any job that keeps dying does. There's no budget over what a file's pages can reach.

#### Encrypted and corrupt files are refused
- GIVEN a file starting `%PDF-` that is encrypted, truncated, or whose `startxref` doesn't land on `xref` or an object
- WHEN it is ingested
- THEN it ends `pdf_unreadable`, and the parser never opens it

#### Too many objects or pages are refused
- GIVEN a PDF whose trailer `/Size` is over 100,000, or with over 5,000 pages
- WHEN it is ingested
- THEN it ends `pdf_unreadable`, read from the trailer where it can be
- AND the largest real sample has 8,561 objects, and at the samples' 230 to 554 words a page, 5,000 pages holds 1.2M to 2.8M words
- AND a parse reads at most 500,000 text items, 8 MiB of text (about 1.4M words, so a very dense file can end this way before 5,000 pages) and 50,000 links to the original archive, and past any of them it ends `pdf_unreadable`, whose message says it may be very long

#### A stream that inflates too far is refused
- GIVEN a small PDF with a stream that inflates to hundreds of MB
- WHEN it is ingested
- THEN it ends `zip_bomb`, as an epub does, without the parser opening it, so the parser's memory never comes into it
- AND a test shows this on the file from "What the tests showed", in workerd
- AND one stream may inflate to 16 MiB, and all of a file's to 128 MiB, which leaves room for a real 10 MB file at the 8.1 to 1 of the largest sample

#### A structure that decodes a stream over and over is refused
- GIVEN a PDF with a form XObject, or a `/Contents` array that repeats a reference, holds more than 8 entries or whose streams inflate past 16 MiB together, or `/Contents` that names an array object
- WHEN it is ingested
- THEN it ends `pdf_unreadable`, and the parser never opens it
- AND a filter that could hide a stream from the check ends the same way: anything but one flate, optionally before a DCT or JPX filter on a stream that says it's an image, or a filter or subtype behind a reference. CCITT and JBIG2 are refused, since a few bytes of either can ask for hundreds of MB, and so is `/Contents` that names an image
- AND so does a stream inside an object stream or a dictionary, which pdf.js reads though the format has neither, an inline image in a dictionary, and an object stream with no filter or whose `/N` or `/First` is behind a reference
- AND the check reads a dictionary as pdf.js does, so what it hides from a simpler reader isn't hidden from this one: names in hex escapes, a key that isn't a name, a `>>` as a value, `+4` and `4.0` as numbers. It keeps only the values it reads, and reads a bounded amount, so a file can't fill the Worker's memory or time with the check itself
- AND what's still open, under the ruling above: an image stream named as a font, and an object stream whose header gives other offsets

#### A long parse keeps its lease
- GIVEN a PDF near every limit
- WHEN it is parsed
- THEN the parse yields between pages, so the lease's renewal timer can fire, and the lease stays renewed
- AND a Worker that dies mid-parse is retried as any job is

### What a reader gets

#### The text is built, not copied
- GIVEN any PDF
- WHEN its chapters are stored
- THEN the HTML is written by the processor from plain text, with everything escaped, and goes through the same sanitizer as an epub's
- AND scene-break lines of symbols are kept. Nothing else from the PDF becomes markup

#### Chapters read as ordinary chapters
- GIVEN a live PDF version
- WHEN a reader opens a chapter or `/full`
- THEN it uses the same pages, cache, warnings screen, settings and position as any work
- AND chapter summaries and notes go where an epub's do, by their printed labels

#### A reader is told it was converted
- GIVEN a work whose current version is a PDF version
- WHEN a reader opens its work page or a chapter
- THEN the existing "Chapters may be imperfect; a moderator will check." notice shows until a moderator checks it
- AND the work page says "Converted from a PDF", decided from the version's upload format, so it stays after that check

#### Italics and images are left out
- GIVEN a PDF with italics or images
- WHEN it is ingested
- THEN the text is kept without them, and the work's page says only what "A reader is told it was converted" says

#### A moderator can check it
- GIVEN a new PDF version
- WHEN a moderator opens *Works to check*
- THEN it is listed with the wording "Converted from a PDF", and "Tags read from print" for `tags_from_print`, not the raw reason codes, and checks like any other reason
- AND the same words show on the work's own moderation page

#### The original stays a download
- GIVEN a live PDF version
- WHEN a reader uses the download link
- THEN `content.rarepair.fans` serves the PDF as an attachment, with `application/pdf` and the same throttle and refusals as any original
- AND the link says "Download original PDF"

#### Everything that handles an original handles a PDF
- GIVEN a PDF's original at `originals/<upload id>.pdf`
- WHEN its work is removed or hidden, its version is held, or the daily sweep or an edge purge reaches it
- THEN each treats it as it treats an epub's: nothing is left behind in R2 or the edge cache, and a hidden work's file is refused
- AND each of those paths has a test, since each builds the key itself today

### An epub wins

#### An epub replaces a PDF
- GIVEN a work whose current version is a PDF version
- WHEN an epub of the same work that isn't older is ingested: more chapters, or as many with the same date or a later one
- THEN the epub becomes current, with the chapter, tag and author comparisons skipped, since a PDF's text and tags can't be held to an epub's
- AND a moderator's hide or removal still applies as usual, and the version facts carry whether a version came from a PDF

#### An older epub doesn't replace a newer PDF
- GIVEN a work whose current version is a PDF version
- WHEN an older epub of it is ingested
- THEN it ends `duplicate`, as any older upload does

#### A PDF never replaces an epub by itself
- GIVEN a work whose current version came from an epub
- WHEN a PDF of the work is ingested, with no more chapters than that epub, and any date
- THEN it ends `duplicate`, and the uploader sees "Already in the archive" with a link to the work
- AND its file isn't served, unlike an epub's duplicate: no moderator has looked at it, nothing links to it, and any file with the right line on it could be hosted that way
- AND a moderator can't be blocked by this: making an older version current works as it does today, in either direction

#### A PDF with more chapters than the current epub is held
- GIVEN a work whose current version came from an epub
- WHEN a PDF of the work with more chapters is ingested, with any date
- THEN it ends `held_for_review`, with the hold reason `pdf_more_chapters`, and the work stays as it is
- AND *Works to check* lists it as "A PDF with more chapters than the current epub", and a moderator can make it current (operator's ruling, 2026-11-07)

#### A PDF follows the rules against a PDF
- GIVEN a work whose current version is a PDF version
- WHEN a newer PDF is ingested
- THEN the usual version rules decide: `not_newer`, replace or hold

#### The re-sanitize backfill knows a PDF
- GIVEN a PDF version
- WHEN the re-sanitize backfill reaches it
- THEN it is re-made through the PDF processor, or left as it is and counted, and never fed to the epub processor

### Nothing else changes

#### Epubs behave as they did
- GIVEN any epub
- WHEN it is uploaded, ingested and read
- THEN every spec in `mvp/` holds, and `unpdf` isn't loaded for it

#### The web and content Workers stay small
- GIVEN the built Workers
- WHEN their bundles are checked
- THEN `unpdf` is only in the ingest Worker

## Before it ships

These can't be shown by the tests in this repository, and they go to the operator:

1. Test real multi-chapter PDFs with a matching epub, including a recent AO3 Calibre export if one can be found. The tests so far only checked two single-chapter conversions. If per-chapter words differ by over about 2%, or fields don't match, this needs another look.
2. On Cloudflare, ingest a 10 MB PDF and a file near the page limit, and read CPU time and memory in the logs. Local workerd enforces no CPU limit.
3. Try one PDF with images, and a one-chapter browser print, since no sample covered them. A PDF whose images inflate past 16 MiB each, or 128 MiB together, is refused as `zip_bomb`, and this is where that would show up.
4. Try a PDF from a word processor, which no sample covered: if it uses a form XObject or a long `/Contents` array it's refused, and that check may need loosening.

## Not in this

- Italics. They could come back if a measurement on Cloudflare shows the memory fits
- Images from a PDF
- Scanned PDFs: with no text, they have no "Posted originally" line, so they end `not_ao3`
- PDFs inside a zip
