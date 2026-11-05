import type { Page } from "playwright";
import { describe, expect, it, onTestFinished } from "vitest";
import {
  sendFiles,
  uploadFilesThroughPage,
  uploadThroughPage,
  useJourneySite,
} from "../harness/journey";
import { R2_HOST } from "../harness/r2-put";
import { signedIn } from "../harness/sessions";
import { SITE, type Site } from "../harness/site";
import { startAtHome, viaHeader } from "../harness/walk";
import { chapterSentence, generatedEpub } from "./epubs";

// An uploader's files from the page to a reader: the page's script asks for URLs, PUTs each file
// to the R2 stand-in with a progress bar, confirms it, and ingest makes it a work. Works here
// take AO3 ids 41900 to 41909; epubs are built in the test (epubs.ts).
describe("upload journeys", () => {
  const running = useJourneySite();

  const uploader = (email: string) => signedIn(running.site, { email, role: "uploader" });

  /** The AO3 ids of the works that exist, from `ids`. */
  const worksAmong = async (site: Site, ids: number[]) =>
    (
      await site.db
        .selectFrom("works")
        .select("ao3_work_id")
        .where("ao3_work_id", "in", ids)
        .orderBy("ao3_work_id")
        .execute()
    ).map((work) => work.ao3_work_id);

  /** The My uploads row for upload `id`. */
  const myUploadsRow = async (page: Page, id: string) => {
    await viaHeader(page, "My uploads");
    return page.locator(`li[data-upload-id="${id}"]`);
  };

  it("One file shows progress, is confirmed and ends live, and its chapter reads signed out", async () => {
    const { site } = running;
    const { context, userId } = await uploader("pw2-one@example.test");
    const page = await context.newPage();
    const file = { name: "one.epub", bytes: generatedEpub({ workId: 41900 }) };

    // Hold the PUT, so the page has to show an upload under way.
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    // A failed assertion must not leave the PUT held, or closing the page would wait on it.
    onTestFinished(() => release());
    await page.route(`https://${R2_HOST}/**`, async (route) => {
      await held;
      await route.continue();
    });
    // What the web Worker is sent: the file's bytes must not be among it (scenario 02).
    const toWeb: { method: string; bytes: number }[] = [];
    page.on("request", (request) => {
      if (request.url().startsWith(SITE)) {
        toWeb.push({ method: request.method(), bytes: request.postData()?.length ?? 0 });
      }
    });

    const [put] = await Promise.all([
      page.waitForRequest((request) => request.method() === "PUT"),
      sendFiles(page, [file]),
    ]);
    expect(put.url().startsWith(`https://${R2_HOST}/rarepair/uploads/`)).toBe(true);
    const row = page.locator("#files li");
    await expect.poll(() => row.innerText()).toContain("Uploading.");
    await expect.poll(() => row.locator("progress").isVisible()).toBe(true);
    release();
    await expect.poll(() => row.innerText()).toContain("Uploaded.");

    expect(toWeb.some((request) => request.method === "PUT")).toBe(false);
    expect(toWeb.every((request) => request.bytes < file.bytes.length)).toBe(true);

    const upload = await site.db
      .selectFrom("uploads")
      .select("id")
      .where("user_id", "=", userId)
      .executeTakeFirstOrThrow();
    await site.waitForUpload(upload.id);

    // A reader who is not signed in opens the new work and its chapter, from the home page,
    // where the new work shows in "Recently added".
    const reader = await startAtHome(await site.newContext());
    await Promise.all([
      reader.waitForEvent("load"),
      reader
        .locator("ol.work-list")
        .getByRole("link", { name: "Synthetic Work 41900", exact: true })
        .click(),
    ]);
    await reader.locator(".chapters a").first().click();
    await expect
      .poll(() => reader.locator("main").innerText())
      .toContain(chapterSentence(41900, 1));
  });

  it("Several files are each confirmed and each ends live", async () => {
    const { site } = running;
    const { context, userId } = await uploader("pw2-several@example.test");
    const page = await context.newPage();
    const ids = [41901, 41902, 41903];
    const files = ids.map((workId) => ({
      name: `work-${workId}.epub`,
      bytes: generatedEpub({ workId }),
    }));

    const uploads = await uploadFilesThroughPage(site, page, userId, files);
    expect(new Set(uploads).size).toBe(3);
    await Promise.all(uploads.map((id) => site.waitForUpload(id)));

    expect(await worksAmong(site, ids)).toEqual(ids);
    await viaHeader(page, "My uploads");
    await expect.poll(() => page.locator("li[data-status='live']").count()).toBe(3);
  });

  it("A second upload of the same file ends duplicate", async () => {
    const { site } = running;
    const { context, userId } = await uploader("pw2-duplicate@example.test");
    const page = await context.newPage();
    // The same spec builds the same bytes, so the same hash.
    const first = await uploadThroughPage(site, page, userId, {
      name: "first.epub",
      bytes: generatedEpub({ workId: 41904 }),
    });
    await site.waitForUpload(first);

    await sendFiles(page, [{ name: "again.epub", bytes: generatedEpub({ workId: 41904 }) }]);
    await expect
      .poll(() => page.locator("#files li").innerText())
      .toContain("We already have this one.");
    const second = await site.db
      .selectFrom("uploads")
      .select("id")
      .where("user_id", "=", userId)
      .where("id", "!=", first)
      .executeTakeFirstOrThrow();
    await site.waitForUpload(second.id, "duplicate");

    const row = await myUploadsRow(page, second.id);
    await expect.poll(() => row.locator(".badge").innerText()).toBe("Already in the archive");
    await expect
      .poll(() => row.locator(".upload-message").innerText())
      .toContain("already in the archive, so nothing was added");
    expect(await worksAmong(site, [41904])).toEqual([41904]);
  });

  it("A corrupt file ends with its plain-language message", async () => {
    const { site } = running;
    const { context, userId } = await uploader("pw2-corrupt@example.test");
    const page = await context.newPage();
    // Not a zip: it passes the page's own checks (name, size) and ingest refuses it.
    const id = await uploadThroughPage(site, page, userId, {
      name: "corrupt.epub",
      bytes: new TextEncoder().encode("This is not a zip file, only synthetic text."),
    });
    await site.waitForUpload(id, "not_epub");

    const row = await myUploadsRow(page, id);
    await expect.poll(() => row.locator(".badge").innerText()).toBe("Rejected: not an EPUB");
    await expect
      .poll(() => row.locator(".upload-message").innerText())
      .toContain("isn't a valid EPUB, so we couldn't read it");
  });
});
