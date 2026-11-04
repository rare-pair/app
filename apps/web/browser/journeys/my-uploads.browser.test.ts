import { insertUpload } from "@archive/db";
import { describe, expect, it } from "vitest";
import { useJourneySite } from "../harness/journey";
import { seedReadableWork } from "../harness/seed";
import { signedIn } from "../harness/sessions";
import { SITE, type Site } from "../harness/site";

// My uploads follows an upload from Processing to Live: in place by the page's script, and by the
// head's meta refresh when scripts are off. The row is seeded in Processing, as 21-no-js does,
// because racing the real ingest to catch it there would be a flake; ingest to live is shown by
// the upload journeys. Works here take AO3 ids 41910 and 41911.
describe("My uploads journeys", () => {
  const running = useJourneySite();
  // Both refreshes come every 5 seconds, and a busy machine may take a few more.
  const REFRESH_WAIT = { timeout: 25_000 };

  /** A confirmed upload in progress for `userId`: it shows Processing and is polled. */
  const seedProcessing = async (site: Site, userId: string) => {
    const { id } = await insertUpload(site.db, {
      userId,
      r2Key: `uploads/pw2-${crypto.randomUUID()}`,
      bytes: 1234,
    });
    await site.db
      .updateTable("uploads")
      .set({ status: "processing", quota_counted_at: new Date() })
      .where("id", "=", id)
      .execute();
    return id;
  };

  /** What ingest does last: the upload goes live on a work. */
  const goLive = async (site: Site, id: string, ao3WorkId: number) => {
    const work = await seedReadableWork(site, { ao3WorkId, title: `Synthetic Work ${ao3WorkId}` });
    await site.db
      .updateTable("uploads")
      .set({ status: "live", work_id: work.workId })
      .where("id", "=", id)
      .execute();
  };

  it("My uploads moves a badge from processing to live with no reload", async () => {
    const { site } = running;
    const { context, userId } = await signedIn(site, {
      email: "pw2-inplace@example.test",
      role: "uploader",
    });
    const id = await seedProcessing(site, userId);
    const page = await context.newPage();
    let loads = 0;
    page.on("load", () => (loads += 1));
    await page.goto(`${SITE}/me/uploads`);
    const row = page.locator(`li[data-upload-id="${id}"]`);
    await expect.poll(() => row.locator(".badge").innerText()).toBe("Processing");
    expect(await row.getAttribute("data-polling")).not.toBeNull();
    // Anything the page sets for itself is gone after a reload.
    await page.evaluate("window.__pw2 = 1");
    const loadsBefore = loads;

    await goLive(site, id, 41910);

    await expect.poll(() => row.locator(".badge").innerText(), REFRESH_WAIT).toBe("Live");
    await expect.poll(() => row.locator(".upload-name a").innerText()).toBe("View the work");
    expect(await page.evaluate("window.__pw2")).toBe(1);
    expect(loads).toBe(loadsBefore);
  });

  it("With JavaScript off, My uploads still refreshes", async () => {
    const { site } = running;
    const signed = await signedIn(site, { email: "pw2-nojs@example.test", role: "uploader" });
    const id = await seedProcessing(site, signed.userId);

    // Signing in needs scripts (the Turnstile stand-in), so the session is copied across.
    const off = await site.newContext({ javaScript: false });
    await off.addCookies(await signed.context.cookies());
    const page = await off.newPage();
    let loads = 0;
    page.on("load", () => (loads += 1));
    await page.goto(`${SITE}/me/uploads`);
    const row = page.locator(`li[data-upload-id="${id}"]`);
    await expect.poll(() => row.locator(".badge").innerText()).toBe("Processing");
    const loadsBefore = loads;

    await goLive(site, id, 41911);

    await expect.poll(() => row.locator(".badge").innerText(), REFRESH_WAIT).toBe("Live");
    // The page was reloaded to get there: the head's meta refresh did it. The text can show
    // before the load event fires, so wait for the event rather than read it at once.
    await expect.poll(() => loads).toBeGreaterThan(loadsBefore);
  });
});
