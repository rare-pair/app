import { readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { BrowserContext, Page } from "playwright";
import { afterAll, afterEach, beforeAll, beforeEach, expect } from "vitest";
import { startSite, type Site, type SiteOptions } from "./site";
import { viaHeader } from "./walk";

/** The site a journey runs on, ready once its `beforeAll` has run. */
export type JourneySite = { site: Site };

/**
 * In the enclosing describe block, starts a site and closes it after. Every test in the block
 * then fails on a CSP violation, a console or script error or an unexpected off-site request;
 * a test expecting some, such as an error page's own status line, calls
 * `await site.assertClean({ allow })` itself before it ends. Contexts a test opened close with
 * it, so a journey's video ends with its test.
 */
export function useJourneySite(options?: SiteOptions): JourneySite {
  // SAFETY: filled in by beforeAll, before any test in the block reads it.
  const running = {} as JourneySite;
  beforeAll(async () => {
    running.site = await startSite(options);
  });
  let before = new Set<BrowserContext>();
  beforeEach(() => {
    before = new Set(running.site.contexts());
  });
  afterEach(async () => {
    const { site } = running;
    try {
      await site.assertClean();
    } finally {
      // A page left open would run on, and record on, through the tests after it.
      const opened = site.contexts().filter((context) => !before.has(context));
      await Promise.all(opened.map((context) => context.close()));
    }
    // Anything reported while they closed is this test's too, not the next one's.
    await site.assertClean();
  });
  // When startSite failed there is nothing to close, and its error is the one to see.
  afterAll(async () => {
    if ("site" in running) await running.site.close();
  });
  return running;
}

/** The path of a committed synthetic epub, by its file name under fixtures/epubs/synthetic. */
export const syntheticEpub = (name: string) =>
  join(dirname(fileURLToPath(import.meta.url)), "../../../../fixtures/epubs/synthetic", name);

/** A file to upload: the path of one on disk, or bytes built in the test under a name. */
export type EpubFile = string | { name: string; bytes: Uint8Array };

const EPUB_MIME = "application/epub+zip";
const PDF_MIME = "application/pdf";

/** What `setInputFiles` takes for `file`; a path on disk is read, named for its last segment. */
const payload = (file: EpubFile) => {
  const { name, bytes } =
    // oxlint-disable-next-line deslop/no-runtime-typeof -- tells the string | object union apart
    typeof file === "string" ? { name: basename(file), bytes: readFileSync(file) } : file;
  const mimeType = name.toLowerCase().endsWith(".pdf") ? PDF_MIME : EPUB_MIME;
  return { name, mimeType, buffer: Buffer.from(bytes) };
};

/**
 * Clicks the header's Add work (from home, when `page` is on no page of the site), picks
 * `files` and clicks Upload, then returns without waiting for anything.
 */
export async function sendFiles(page: Page, files: EpubFile[]): Promise<void> {
  await viaHeader(page, "Add work");
  // Files on disk go by path, as the browser reads a file picked in a dialog; only bytes built in
  // the test go as in-memory payloads (setInputFiles takes one form or the other).
  // oxlint-disable-next-line deslop/no-runtime-typeof -- tells the string | object union apart
  const paths = files.filter((file): file is string => typeof file === "string");
  await page.setInputFiles("#file", paths.length === files.length ? paths : files.map(payload));
  await page.getByRole("button", { name: "Upload" }).click();
}

/**
 * Sends `files` as `sendFiles` does and waits until every row says it was accepted or that we
 * already have it. Returns the ids of the `files.length` uploads it made, in no set
 * order. Follow with `site.waitForUpload(id)` for each.
 */
export async function uploadFilesThroughPage(
  site: Site,
  page: Page,
  userId: string,
  files: EpubFile[],
): Promise<string[]> {
  const idsOf = async () =>
    (await site.db.selectFrom("uploads").select("id").where("user_id", "=", userId).execute()).map(
      ({ id }) => id,
    );
  const before = new Set(await idsOf());
  await sendFiles(page, files);
  const rows = page.locator("#files li");
  await expect.poll(() => rows.count()).toBe(files.length);
  for (let i = 0; i < files.length; i++) {
    await expect
      .poll(() => rows.nth(i).innerText())
      .toMatch(/Uploaded\.|We already have this one\./);
  }
  const added = (await idsOf()).filter((id) => !before.has(id));
  // Every row was asked for, so each file has an upload of its own.
  expect(added).toHaveLength(files.length);
  return added;
}

/**
 * Uploads one file through `/upload` as a signed-in `page` does, until the page says it was
 * accepted or already held, and returns the upload's id. Follow with `site.waitForUpload(id)`,
 * or `site.waitForUpload(id, "duplicate")` for a second upload.
 */
export async function uploadThroughPage(
  site: Site,
  page: Page,
  userId: string,
  file: EpubFile,
): Promise<string> {
  const [id] = await uploadFilesThroughPage(site, page, userId, [file]);
  // SAFETY: one file was sent, so one id came back.
  return id as string;
}
