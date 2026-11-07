import { describe, expect, it } from "vitest";
import { useJourneySite } from "../harness/journey";
import { signedIn } from "../harness/sessions";
import { viaHeader } from "../harness/walk";
import { generatedEpub } from "./epubs";

// The upload page's list (scenario 02): files picked or dropped wait in an editable list, and a
// long list goes in groups of 10. Works here take AO3 ids 8813400 to 8813411.
describe("upload list journey", () => {
  const running = useJourneySite();

  const epub = (n: number) => ({
    name: `list-${n}.epub`,
    mimeType: "application/epub+zip",
    buffer: Buffer.from(generatedEpub({ workId: 8813400 + n })),
  });

  it("Picked and dropped files are listed, removed and sent in groups of 10", async () => {
    const { site } = running;
    const { context, userId } = await signedIn(site, {
      email: "uploadlist@example.test",
      role: "uploader",
    });
    const page = await context.newPage();
    await page.setViewportSize({ width: 360, height: 640 });
    await viaHeader(page, "Add work");
    const rows = page.locator("#files li");
    const uploadCount = async () =>
      (await site.db.selectFrom("uploads").select("id").where("user_id", "=", userId).execute())
        .length;
    const asks: number[] = [];
    page.on("request", (request) => {
      if (request.method() === "POST" && new URL(request.url()).pathname === "/uploads") {
        asks.push(new URLSearchParams(request.postData() ?? "").getAll("size").length);
      }
    });

    // Picked files list with name and size, and nothing is sent.
    await page.setInputFiles("#file", [epub(0), epub(1), epub(2)]);
    await expect.poll(() => rows.count()).toBe(3);
    await expect.poll(() => rows.first().innerText()).toMatch(/list-0\.epub \(\d+ KB\)/);
    await expect.poll(() => page.locator("#message").innerText()).toContain("3 files added");

    // Adding more adds, and the same file again shows once. A text file shows its problem.
    await page.setInputFiles("#file", [
      epub(2),
      { name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("synthetic") },
    ]);
    await expect.poll(() => rows.count()).toBe(4);
    await expect.poll(() => page.locator("#message").innerText()).toContain("already in the list");
    await expect.poll(() => rows.nth(3).innerText()).toContain("Not an epub file");

    // Remove takes the row, announces it and moves focus to the row before it.
    await rows.nth(3).getByRole("button", { name: "Remove notes.txt" }).click();
    await expect.poll(() => rows.count()).toBe(3);
    await expect.poll(() => page.locator("#message").innerText()).toContain("Removed notes.txt");
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.getAttribute("aria-label")))
      .toBe("Remove list-2.epub");

    // A file dropped on the marked area joins the list.
    const dropped = epub(3);
    const transfer = await page.evaluateHandle(
      ({ name, type, bytes }) => {
        const data = new DataTransfer();
        data.items.add(new File([new Uint8Array(bytes)], name, { type }));
        return data;
      },
      { name: dropped.name, type: dropped.mimeType, bytes: Array.from(dropped.buffer) },
    );
    await page.locator("#drop").dispatchEvent("drop", { dataTransfer: transfer });
    await expect.poll(() => rows.count()).toBe(4);

    // Eight more make twelve; nothing has gone out yet.
    await page.setInputFiles(
      "#file",
      [4, 5, 6, 7, 8, 9, 10, 11].map((n) => epub(n)),
    );
    await expect.poll(() => rows.count()).toBe(12);
    expect(await uploadCount()).toBe(0);
    expect(asks).toEqual([]);
    // No sideways scroll at 360 px with the long list.
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      360,
    );

    // Upload sends ten, then the other two, each group once the one before is confirmed.
    await page.getByRole("button", { name: "Upload" }).click();
    for (let i = 0; i < 12; i++) {
      await expect.poll(() => rows.nth(i).innerText(), { timeout: 60000 }).toContain("Uploaded.");
    }
    expect(asks).toEqual([10, 2]);
    expect(await uploadCount()).toBe(12);
    const ids = await site.db
      .selectFrom("uploads")
      .select("id")
      .where("user_id", "=", userId)
      .execute();
    await Promise.all(ids.map(({ id }) => site.waitForUpload(id)));
  }, 180000);
});
