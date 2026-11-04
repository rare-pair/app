import { describe, expect, it } from "vitest";
import { uploadThroughPage, useJourneySite } from "../harness/journey";
import {
  approveAndRemove,
  expectLogged,
  insertRequest,
  openRow,
  purgeRequests,
  requesterEmail,
} from "../harness/moderation";
import { seedReadableWork } from "../harness/seed";
import { signedIn } from "../harness/sessions";
import { SITE, type Site } from "../harness/site";
import { byAddress, startAtHome, viaHeader } from "../harness/walk";
import { chapterSentence, generatedEpub } from "./epubs";

// A moderator approves a removal: the work's pages answer 410 and its files leave the bucket the
// content Worker serves from (ARCHITECTURE, "Removal really removes": status, then R2, then the
// edge cache's purge). The purge itself is deploy-only: here it is a stand-in for Cloudflare's
// API that records the request and clears no cache, so these journeys show what web asked to be
// purged (`purgeRequests`) and the result page's "Its caches are cleared", never a zone or
// browser cache cleared. The content Worker keeps its own Miniflare cache of each plain GET 200
// and nothing here purges it, so before a removal the content checks send a Range header, which
// bypasses that cache both ways; a plain GET before would make the same GET after it a stale
// 200 here (checked: it does) that the deployed purge would have cleared. Works take AO3 ids
// 42300 and 42301. The moderation log has no page, so each journey checks its rows at the end.
describe("removal journeys", () => {
  const running = useJourneySite();
  const CONTENT = "https://content.rarepair.fans";
  // A made-up image key: ingest names an image by the SHA-256 hex of its bytes (save.ts).
  const IMAGE_HASH = "ab".repeat(32);
  const RANGE = { range: "bytes=0-" };

  /** The work's database id, and the id and R2 key of its upload. */
  const workRow = async (site: Site, ao3WorkId: number) => {
    const work = await site.db
      .selectFrom("works")
      .select("id")
      .where("ao3_work_id", "=", ao3WorkId)
      .executeTakeFirstOrThrow();
    const upload = await site.db
      .selectFrom("uploads")
      .select(["id", "r2_key"])
      .where("work_id", "=", work.id)
      .executeTakeFirstOrThrow();
    return { workId: work.id, uploadId: upload.id, uploadKey: upload.r2_key };
  };

  it("Approving a confirmed request removes the work and its files", async () => {
    const { site } = running;
    const mod = await signedIn(site, { email: requesterEmail("mod-removal"), role: "moderator" });
    // The moderator's page is the first recorded; the reader's, opened second, is the "-2" video.
    const page = await startAtHome(mod.context);
    const reader = await (await site.newContext()).newPage();

    // A real upload, so the work and its original are where ingest puts them; only the image
    // is put here, under the key its layout gives.
    const uploader = await signedIn(site, {
      email: requesterEmail("uploader-removal"),
      role: "uploader",
    });
    const uploaderPage = await uploader.context.newPage();
    site.dropRecording(uploaderPage);
    const epub = generatedEpub({ workId: 42300, chapters: 2 });
    await site.waitForUpload(
      await uploadThroughPage(site, uploaderPage, uploader.userId, { name: "w.epub", bytes: epub }),
    );
    const { workId, uploadId, uploadKey } = await workRow(site, 42300);
    const imageKey = `works/42300/img/${IMAGE_HASH}`;
    await site.bucket.put(imageKey, new Uint8Array([1, 2, 3]), {
      httpMetadata: { contentType: "image/png" },
    });
    const originalKey = `originals/${uploadId}.epub`;
    const requestId = await insertRequest(site, {
      workId,
      email: requesterEmail("requester-removal"),
    });

    // Before: a reader reads it, and the bucket holds its fragments, image and original.
    await reader.goto(`${SITE}/works/42300`);
    await expect.poll(() => reader.locator(".chapters a").count()).toBe(2);
    expect((await site.bucket.list({ prefix: "works/42300/" })).objects.length).toBeGreaterThan(2);
    expect(await site.bucket.head(originalKey)).not.toBeNull();
    expect(await site.bucket.head(uploadKey)).not.toBeNull();
    expect((await site.fetch(`${CONTENT}/${imageKey}`, { headers: RANGE })).status).toBe(200);
    expect((await site.fetch(`${CONTENT}/${originalKey}`, { headers: RANGE })).status).toBe(200);

    // The moderator: Requests, the row, Approve, then the confirm step.
    await viaHeader(page, "Admin");
    await page.getByRole("link", { name: "Requests" }).click();
    await page.waitForURL(/\/admin\/requests$/);
    await openRow(page, "(42300)");
    await approveAndRemove(page);
    await expect
      .poll(() => page.locator("main").innerText())
      .toContain("The work is removed and its files are deleted. Its caches are cleared.");

    // Every object of the work is gone from the bucket the content Worker serves from.
    expect((await site.bucket.list({ prefix: "works/42300/" })).objects).toHaveLength(0);
    expect(await site.bucket.head(originalKey)).toBeNull();
    expect(await site.bucket.head(uploadKey)).toBeNull();
    expect((await site.fetch(`${CONTENT}/${imageKey}`)).status).toBe(404);
    expect((await site.fetch(`${CONTENT}/${originalKey}`)).status).toBe(404);

    // The reader's pages answer 410 for the work and for a chapter.
    const work = await byAddress(reader, "/works/42300", "a removed work is listed nowhere");
    expect(work?.status()).toBe(410);
    await expect.poll(() => reader.locator("main").innerText()).toContain("removed");
    expect(await reader.locator("main").innerText()).not.toContain(chapterSentence(42300, 1));
    const chapter = await byAddress(
      reader,
      "/works/42300/chapters/1",
      "a removed work is listed nowhere",
    );
    expect(chapter?.status()).toBe(410);

    // What web asked Cloudflare to purge: the work's tag, its images' prefix, its original.
    const purges = (await purgeRequests()).map((p) => p.body);
    expect(purges).toContainEqual({ tags: ["work-42300"] });
    expect(purges).toContainEqual({ prefixes: ["content.rarepair.fans/works/42300/img/"] });
    const files = purges.flatMap((b) => b.files ?? []);
    expect(files).toContain(`${CONTENT}/originals/${uploadId}.epub`);

    // The approve and the removal itself are both in the moderation log.
    await expectLogged(site, {
      action: "approve",
      targetKind: "request",
      targetId: requestId,
      moderatorId: mod.userId,
    });
    await expectLogged(site, {
      action: "remove",
      targetKind: "work",
      targetId: workId,
      moderatorId: mod.userId,
    });
    await site.assertClean({ allow: [/status of 410/] });
  });

  it("Approving a takedown removes the work", async () => {
    const { site } = running;
    const mod = await signedIn(site, { email: requesterEmail("mod-takedown"), role: "moderator" });
    const page = await startAtHome(mod.context);
    const work = await seedReadableWork(site, {
      ao3WorkId: 42301,
      title: "Synthetic Work 42301",
      chapters: 2,
    });
    const takedown = await site.db
      .insertInto("takedowns")
      .values({
        work_id: work.workId,
        requester: requesterEmail("notice"),
        basis: "A synthetic basis for a journey.",
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    // Its image and original, put under the keys ingest uses, as the removal journey above shows.
    const imageKey = `works/42301/img/${IMAGE_HASH}`;
    const originalKey = `originals/${work.uploadId}.epub`;
    await site.bucket.put(imageKey, new Uint8Array([1, 2, 3]), {
      httpMetadata: { contentType: "image/png" },
    });
    await site.bucket.put(originalKey, new Uint8Array([4, 5, 6]));
    expect((await site.fetch("/works/42301")).status).toBe(200);
    expect((await site.fetch(`${CONTENT}/${imageKey}`, { headers: RANGE })).status).toBe(200);
    expect((await site.fetch(`${CONTENT}/${originalKey}`, { headers: RANGE })).status).toBe(200);

    await viaHeader(page, "Admin");
    await page.getByRole("link", { name: "Takedowns" }).click();
    await page.waitForURL(/\/admin\/takedowns$/);
    await openRow(page, "(42301)");
    await approveAndRemove(page);
    await expect
      .poll(() => page.locator("main").innerText())
      .toContain("The work is removed and its files are deleted.");

    const row = await site.db
      .selectFrom("takedowns")
      .select(["status", "resolved_by"])
      .where("id", "=", takedown.id)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({ status: "removed", resolved_by: mod.userId });
    expect((await site.bucket.list({ prefix: "works/42301/" })).objects).toHaveLength(0);
    expect(await site.bucket.head(originalKey)).toBeNull();
    expect((await site.fetch(`${CONTENT}/${imageKey}`)).status).toBe(404);
    expect((await site.fetch(`${CONTENT}/${originalKey}`)).status).toBe(404);
    expect((await site.fetch("/works/42301")).status).toBe(410);
    expect((await site.fetch("/works/42301/chapters/1")).status).toBe(410);
    await expectLogged(site, {
      action: "approve",
      targetKind: "takedown",
      targetId: takedown.id,
      moderatorId: mod.userId,
    });
  });
});
