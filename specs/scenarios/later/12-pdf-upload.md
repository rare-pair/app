# Scenario: Upload a PDF of an AO3 work

Relates to: docs/ARCHITECTURE.md § Ingestion pipeline, § Dedupe, § Reading (Download original epub), § The re-sanitize backfill; docs/FRONTEND-DISCOVERY.md § Key journeys (3); specs/scenarios/mvp/02-upload-handshake.md; specs/scenarios/mvp/06-ao3-preface-and-chapters.md; specs/scenarios/mvp/08-versioning-and-dedupe.md; specs/scenarios/mvp/09-content-origin.md

Status: not built. Some readers only saved a PDF, and with the original archive offline they can't get an epub. This accepts those files, narrowly, and accepts that the result reads less well than an epub. An epub always wins over a PDF.

## What the tests showed

From throwaway tests on 2026-11-07 of 8 PDFs: 2 AO3 exports or copies of them, 4 browser prints of AO3's HTML download, and 2 Calibre conversions of epubs. The numbers are recorded here because the test folder doesn't last. They were run in Node and in local workerd, not on Cloudflare.

- **What survives:** the work ID, tags and authors from link annotations, and the printed "Posted originally" URL, which agreed with the link in 8 of 8. The chapter count matched the declared count in 8 of 8. The 2 Calibre conversions matched their epubs on all 26 compared fields, and on words within 0.1%.
- **What doesn't survive exactly:** paragraphs are off by 5 to 19%. Italics need `getOperatorList()`, which took +275 MB on a 335-page file, so they're left out here. No sample held an image.
- **Cost:** 2.3 s and +46 MB for the largest real file, text only. 9.1 s and +95 MB for a synthetic 25 MB file. `unpdf` adds 1.66 MB to the bundle. Local workerd enforces no CPU limit, so production's cost is unknown.
- **Hostile files:** a 50,000-page file doesn't finish in 60 s. A 261 KB file that inflates to 256 MB took +455 MB, with nothing visible before inflating.

Only 2 of the 8 could be checked against an epub, and both are single-chapter. See "Before it ships".

## Setup

- Fixtures are synthetic PDFs built by a script in the tests, holding no fic text. Real PDFs stay on the operator's machine under `fixtures/`, and `fixtures/**/*.pdf` is git-ignored
- A file is a PDF because of its bytes, not its name or the type it was sent with
- The 25 MB limit, the daily quota, Turnstile and the rate limits are the same as for an epub, and a PDF counts as one upload
- A **PDF version** is a work version made from a PDF. It carries the review reason `from_pdf`, so it goes live with the existing notice, and it never holds an upload by itself

## Cases

### Uploading

#### The upload page takes PDFs
- GIVEN a signed-in uploader on the upload page
- WHEN they pick or drop a `.pdf` file
- THEN it joins the list like an epub, goes through the same `POST /uploads`, `PUT` and confirm, and shows its own status on `/me/uploads`
- AND the page's wording says PDFs are accepted, and that an epub reads better if they have one

#### A file's bytes decide what it is
- GIVEN a PDF named `.epub`, or an epub named `.pdf`
- WHEN it is ingested
- THEN it goes through the processor its bytes call for

#### A zip doesn't hold PDFs yet
- GIVEN a zip of epubs and PDFs on the upload page
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
- THEN it ends `not_ao3`, as an epub does, and its stored file is deleted

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

#### The chapter count must match
- GIVEN a PDF whose chapters can't be found in the number its `Chapters:` line declares
- WHEN it is ingested
- THEN it is refused with `pdf_unreadable`, whose message says the chapters couldn't be told apart and that an epub would work

#### A work with one chapter has nothing to split
- GIVEN a PDF declaring one chapter, or with no `Chapters:` line, which counts as one
- WHEN it is ingested
- THEN everything between the preface and the afterword is its chapter

### Hostile files

Each stops before the parser opens the file, or stops it within its budget. The job ends with no retry, and its stored file is deleted.

#### Encrypted and corrupt files are refused
- GIVEN an encrypted PDF, random bytes named `.pdf`, a truncated PDF, or one whose `startxref` doesn't land on `xref` or an object
- WHEN it is ingested
- THEN it ends `pdf_unreadable`, and the parser never opens it

#### Too many objects or pages are refused
- GIVEN a PDF whose trailer `/Size` is over 100,000, or with over 5,000 pages
- WHEN it is ingested
- THEN it ends `pdf_unreadable`, read from the trailer where it can be
- AND the largest real sample has 8,561 objects, and 5,000 pages holds about 1M words

#### A stream that inflates too far is refused
- GIVEN a small PDF with a stream that inflates to hundreds of MB
- WHEN it is ingested
- THEN it ends `zip_bomb`, as an epub does, with the Worker still inside its memory limit
- AND a test shows this on the file from "What the tests showed", in workerd

#### A long parse keeps its lease
- GIVEN a PDF near every limit
- WHEN it is parsed
- THEN the job's lease stays renewed, and a Worker that dies mid-parse is retried as any job is

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
- AND the work page says "Converted from a PDF", which stays after that check

#### Italics and images are left out
- GIVEN a PDF with italics or images
- WHEN it is ingested
- THEN the text is kept without them, and the work's page says only what "A reader is told it was converted" says

#### A moderator can check it
- GIVEN a new PDF version
- WHEN a moderator opens *Works to check*
- THEN it is listed with the reason "Converted from a PDF", and checks like any other reason

#### The original stays a download
- GIVEN a live PDF version
- WHEN a reader uses the download link
- THEN `content.rarepair.fans` serves the PDF as an attachment, with `application/pdf` and the same throttle and refusals as any original
- AND the link says "Download original PDF"

### An epub always wins

#### An epub replaces a PDF
- GIVEN a work whose current version is a PDF version
- WHEN an epub of the same work, with the same date and chapter count or newer, is ingested
- THEN the epub becomes current, whether or not the version rules would call it newer
- AND a moderator's hide, or a hold on tags or authors changing, still applies as usual

#### A PDF never replaces an epub
- GIVEN a work whose current version came from an epub
- WHEN a PDF of the work is ingested, with any date
- THEN it ends `duplicate`, and the uploader sees "Already in the archive" with a link to the work

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
2. On Cloudflare, ingest a 25 MB PDF and a file near the page limit, and read CPU time and memory in the logs. Local workerd enforces no CPU limit.
3. Try one PDF with images, and a one-chapter browser print, since no sample covered them.

## Not in this

- Italics. They could come back if a measurement on Cloudflare shows the memory fits
- Images from a PDF
- Scanned PDFs: with no text, they have no "Posted originally" line, so they end `not_ao3`
- PDFs inside a zip
