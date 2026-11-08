import { readFile } from "node:fs/promises";
import type { Page } from "playwright";
import { describe, expect, it } from "vitest";
import { ao3Pdf } from "../../../ingest/test/pdf-builder";
import { CONTENT_HOST } from "../../src/content-host";
import { syntheticEpub, uploadThroughPage, useJourneySite } from "../harness/journey";
import { signedIn } from "../harness/sessions";
import { viaHeader } from "../harness/walk";

// One upload through every real Worker: the page's script, the PUT, the queue to ingest, the
// reader on web, and the content host. Ingested works keep the ids inside the fixtures.
describe("upload journey", () => {
  const running = useJourneySite();

  /** Opens the uploaded work as its uploader does: My uploads, then the upload's row link. */
  const openFromMyUploads = async (page: Page, uploadId: string) => {
    await viaHeader(page, "My uploads");
    await Promise.all([
      page.waitForEvent("load"),
      page.locator(`li[data-upload-id="${uploadId}"] a`).click(),
    ]);
  };

  it("An uploaded epub is ingested and its chapter reads", async () => {
    const { site } = running;
    const { context, userId } = await signedIn(site, {
      email: "pw0-one-shot@example.test",
      role: "uploader",
    });
    const page = await context.newPage();
    const id = await uploadThroughPage(
      site,
      page,
      userId,
      syntheticEpub("synthetic-one-shot-01.epub"),
    );
    await site.waitForUpload(id);

    await openFromMyUploads(page, id);
    await page.locator(".chapters a").first().click();
    await expect
      .poll(() => page.locator("main").innerText())
      .toContain("Sentence 1 of the synthetic one-shot 1000101");
  });

  it("12-pdf-upload: an uploaded PDF reads as a converted work, and downloads as a PDF", async () => {
    const { site } = running;
    const { context, userId } = await signedIn(site, {
      email: "pw0-pdf@example.test",
      role: "uploader",
    });
    const page = await context.newPage();
    const bytes = ao3Pdf({
      workId: 8813790,
      title: "A synthetic PDF",
      chapters: [{ paragraphs: ["The synthetic text of the PDF.", "More of it."] }],
    });
    const id = await uploadThroughPage(site, page, userId, { name: "synthetic.pdf", bytes });
    await site.waitForUpload(id);

    await openFromMyUploads(page, id);
    const main = page.locator("main");
    await expect.poll(() => main.innerText()).toContain("Converted from a PDF");
    expect(await main.innerText()).toContain("Chapters may be imperfect; a moderator will check.");

    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("link", { name: "Download original PDF" }).click(),
    ]);
    expect(download.url()).toBe(`https://${CONTENT_HOST}/originals/${id}.pdf`);
    expect((await readFile(await download.path())).equals(Buffer.from(bytes))).toBe(true);

    await page.locator(".chapters a").first().click();
    await expect.poll(() => main.innerText()).toContain("The synthetic text of the PDF.");
  });

  it("An image and the original download come from the content Worker", async () => {
    const { site } = running;
    const { context, userId } = await signedIn(site, {
      email: "pw0-images@example.test",
      role: "uploader",
    });
    const page = await context.newPage();
    const fixture = syntheticEpub("synthetic-images-01.epub");
    const id = await uploadThroughPage(site, page, userId, fixture);
    await site.waitForUpload(id);

    await openFromMyUploads(page, id);
    const [image] = await Promise.all([
      page.waitForResponse((res) =>
        res.url().startsWith(`https://${CONTENT_HOST}/works/1000104/img/`),
      ),
      page.locator(".chapters a").first().click(),
    ]);
    expect(image.status()).toBe(200);
    expect(image.headers()["content-type"]).toBe("image/png");
    expect(image.headers()["x-content-type-options"]).toBe("nosniff");
    const figure = page.getByAltText("A synthetic figure");
    await expect
      .poll(() => figure.evaluate((img: HTMLImageElement) => img.naturalWidth))
      .toBeGreaterThan(0);

    await openFromMyUploads(page, id);
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("link", { name: "Download original epub" }).click(),
    ]);
    expect(download.url()).toBe(`https://${CONTENT_HOST}/originals/${id}.epub`);
    expect((await readFile(await download.path())).equals(await readFile(fixture))).toBe(true);
  });
});
