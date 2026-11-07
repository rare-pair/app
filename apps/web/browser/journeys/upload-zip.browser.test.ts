import { describe, expect, it } from "vitest";
import { zipEntries } from "../../../../packages/epub/test/build";
import { useJourneySite } from "../harness/journey";
import { signedIn } from "../harness/sessions";
import { viaHeader } from "../harness/walk";
import { generatedEpub } from "./epubs";

// A zip of epubs on the upload page (scenario 26): the browser's own DecompressionStream opens
// it, each epub joins the list, and each goes through the normal upload path. Works here take
// AO3 ids 8813600 to 8813601.
describe("upload zip journey", () => {
  const running = useJourneySite();

  it("A zip of epubs adds each epub to the list, and each is uploaded as its own work", async () => {
    const { site } = running;
    const { context, userId } = await signedIn(site, {
      email: "uploadzip@example.test",
      role: "uploader",
    });
    const page = await context.newPage();
    await page.setViewportSize({ width: 360, height: 640 });
    await viaHeader(page, "Add work");
    const rows = page.locator("#files li");

    const zip = zipEntries(
      {
        "stories/zip-0.epub": generatedEpub({ workId: 8813600 }),
        "stories/deep/zip-1.epub": generatedEpub({ workId: 8813601 }),
        "readme.txt": "synthetic",
      },
      null,
    );
    await page.setInputFiles("#file", {
      name: "books.zip",
      mimeType: "application/zip",
      buffer: Buffer.from(zip),
    });
    await expect.poll(() => rows.count()).toBe(3);
    const readme = rows.filter({ hasText: "readme.txt" });
    await expect.poll(() => readme.innerText()).toContain("Skipped");
    const first = rows.filter({ hasText: "zip-0.epub" });
    const second = rows.filter({ hasText: "zip-1.epub" });
    await expect.poll(() => first.count()).toBe(1);
    await expect.poll(() => second.count()).toBe(1);
    await expect
      .poll(() => page.locator("#message").innerText())
      .toContain("2 epubs added from books.zip");
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      360,
    );

    await page.getByRole("button", { name: "Upload" }).click();
    for (const row of [first, second]) {
      await expect.poll(() => row.innerText(), { timeout: 60000 }).toContain("Uploaded.");
    }
    const ids = await site.db
      .selectFrom("uploads")
      .select("id")
      .where("user_id", "=", userId)
      .execute();
    expect(ids).toHaveLength(2);
    await Promise.all(ids.map(({ id }) => site.waitForUpload(id)));
  }, 120000);
});
