import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { CONTENT_HOST } from "../../src/content-host";
import { syntheticEpub, uploadThroughPage, useJourneySite } from "../harness/journey";
import { signedIn } from "../harness/sessions";
import { SITE } from "../harness/site";

// One upload through every real Worker: the page's script, the PUT, the queue to ingest, the
// reader on web, and the content host. Ingested works keep the ids inside the fixtures.
describe("upload journey", () => {
  const running = useJourneySite();

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

    await page.goto(`${SITE}/works/1000101`);
    await page.locator(".chapters a").first().click();
    await expect
      .poll(() => page.locator("main").innerText())
      .toContain("Sentence 1 of the synthetic one-shot 1000101");
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

    await page.goto(`${SITE}/works/1000104`);
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

    await page.goto(`${SITE}/works/1000104`);
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("link", { name: "Download original epub" }).click(),
    ]);
    expect(download.url()).toBe(`https://${CONTENT_HOST}/originals/${id}.epub`);
    expect((await readFile(await download.path())).equals(await readFile(fixture))).toBe(true);
  });
});
