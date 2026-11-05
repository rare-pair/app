import type { Page } from "playwright";
import { describe, expect, it } from "vitest";
import { uploadThroughPage, useJourneySite } from "../harness/journey";
import { signedIn } from "../harness/sessions";
import { SITE } from "../harness/site";
import { byAddress, viaHeader, viaSearch } from "../harness/walk";
import { chapterSentence, generatedEpub } from "./epubs";

/** Opens the uploaded work as its uploader does: My uploads, then the upload's row link. */
async function openFromMyUploads(page: Page, uploadId: string): Promise<void> {
  await viaHeader(page, "My uploads");
  await Promise.all([
    page.waitForEvent("load"),
    page.locator(`li[data-upload-id="${uploadId}"] a`).click(),
  ]);
}

// A second upload of a work already in the archive: newer and consistent replaces the current
// version; newer but changed is held and never public (ARCHITECTURE, Ingestion pipeline).
// Works here take AO3 ids 41920 and 41921; each account uploads its versions one after the other.
describe("version journeys", () => {
  const running = useJourneySite();

  it("A newer version replaces the current one", async () => {
    const { site } = running;
    const { context, userId } = await signedIn(site, {
      email: "pw2-replace@example.test",
      role: "uploader",
    });
    const page = await context.newPage();
    const version1 = generatedEpub({
      workId: 41920,
      chapters: 2,
      planned: 3,
      updated: "2020-02-01",
    });
    const first = await uploadThroughPage(site, page, userId, { name: "v1.epub", bytes: version1 });
    await site.waitForUpload(first);
    await openFromMyUploads(page, first);
    expect(await page.locator(".chapters a").count()).toBe(2);

    // One more chapter, the first two as they were.
    const version2 = generatedEpub({
      workId: 41920,
      chapters: 3,
      planned: 3,
      updated: "2020-03-01",
    });
    const second = await uploadThroughPage(site, page, userId, {
      name: "v2.epub",
      bytes: version2,
    });
    await site.waitForUpload(second);

    await openFromMyUploads(page, second);
    await expect.poll(() => page.locator(".chapters a").count()).toBe(3);
    await page.locator(".chapters a").nth(2).click();
    await expect.poll(() => page.locator("main").innerText()).toContain(chapterSentence(41920, 3));
  });

  it("A changed version is held and not public", async () => {
    const { site } = running;
    const { context, userId } = await signedIn(site, {
      email: "pw2-held@example.test",
      role: "uploader",
    });
    const page = await context.newPage();
    const version1 = generatedEpub({
      workId: 41921,
      chapters: 2,
      planned: 3,
      updated: "2020-02-01",
    });
    await site.waitForUpload(
      await uploadThroughPage(site, page, userId, { name: "v1.epub", bytes: version1 }),
    );

    // Newer, but its first chapter was rewritten: a moderator must look at it.
    const changed = generatedEpub({
      workId: 41921,
      chapters: 3,
      planned: 3,
      updated: "2020-03-01",
      rewritten: [1],
    });
    const id = await uploadThroughPage(site, page, userId, { name: "v3.epub", bytes: changed });
    await site.waitForUpload(id, "held_for_review");

    await viaHeader(page, "My uploads");
    const row = page.locator(`li[data-upload-id="${id}"]`);
    await expect.poll(() => row.locator(".badge").innerText()).toBe("Held for review");
    await expect
      .poll(() => row.locator(".upload-message").innerText())
      .toContain("A moderator will check this upload");

    // A reader still sees the version before, and nothing of the held one.
    const reader = await (await site.newContext()).newPage();
    await viaSearch(reader, "Synthetic Work 41921");
    expect(await reader.locator(".chapters a").count()).toBe(2);
    const [res] = await Promise.all([
      reader.waitForResponse((r) => r.url() === `${SITE}/works/41921/chapters/3`),
      byAddress(
        reader,
        "/works/41921/chapters/3",
        "a path no link leads to: the held version's chapter, checked by address",
      ),
    ]);
    expect(res.status()).toBe(404);
    await site.assertClean({ allow: [/status of 404/] });
  });
});
