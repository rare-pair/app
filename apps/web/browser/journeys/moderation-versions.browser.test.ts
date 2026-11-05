import { putFragments, seedVersion } from "@archive/db/seed";
import { describe, expect, it } from "vitest";
import { uploadThroughPage, useJourneySite } from "../harness/journey";
import { expectLogged, requesterEmail } from "../harness/moderation";
import { seedReadableWork } from "../harness/seed";
import { signedIn } from "../harness/sessions";
import { byAddress, startAtHome, viaHeader, viaSearch } from "../harness/walk";
import { chapterSentence, generatedEpub } from "./epubs";

// A moderator changes which version of a work readers get: Make current points the work at an
// older live version, and Approve publishes a version ingest held for review. The two live
// versions of the first work are seeded (an upload that replaces its work is the upload
// journeys'); the held one needs real ingest, as `upload-versions` does, because it is ingest's
// comparison that holds it. Readers look in a browser of their own, unrecorded. A chapter page
// is cached for a minute without the version in its key, so each chapter is read once, after the
// change, never before it. Works take AO3 ids 42360 and 42361.
describe("version journeys", () => {
  const running = useJourneySite();

  const html = (version: number, n: number) => `<p>Text of version ${version}, chapter ${n}.</p>`;

  it("Make current changes the version readers see", async () => {
    const { site } = running;
    const mod = await signedIn(site, { email: requesterEmail("mod-current"), role: "moderator" });
    const page = await startAtHome(mod.context);
    const first = await seedReadableWork(site, {
      ao3WorkId: 42360,
      title: "Synthetic Work 42360",
      chapters: [1, 2].map((n) => ({ html: html(1, n) })),
    });
    // The second version is current: three chapters.
    const second = await seedVersion(site.db, first, {
      chapters: [1, 2, 3].map((n) => ({ html: html(2, n) })),
    });
    await putFragments(site.bucket, second.fragments);

    const reader = await (await site.newContext()).newPage();
    site.dropRecording(reader);
    await viaSearch(reader, "Synthetic Work 42360");
    expect(await reader.locator(".chapters a").count()).toBe(3);

    // The work is live and not flagged, so no queue lists it: its admin page has no link yet
    // (#591).
    await byAddress(page, "/admin/works/42360", "no queue links a live, unflagged work (#591)");
    // Oldest first: the first row is the first version.
    await page.locator("tbody tr").first().getByRole("button", { name: "Make current" }).click();
    await expect
      .poll(() => page.locator("main").innerText())
      .toContain("That version is now current.");

    await reader.reload();
    await expect.poll(() => reader.locator(".chapters a").count()).toBe(2);
    await reader.locator(".chapters a").first().click();
    await expect.poll(() => reader.locator("main").innerText()).toContain("Text of version 1");
    const gone = await byAddress(
      reader,
      "/works/42360/chapters/3",
      "a chapter that's gone has no link",
    );
    expect(gone?.status()).toBe(404);
    await expectLogged(site, {
      action: "make_current",
      targetKind: "version",
      targetId: first.versionId,
      moderatorId: mod.userId,
    });
    await site.assertClean({ allow: [/status of 404/] });
  });

  it("A held version is approved from Works to check", async () => {
    const { site } = running;
    const mod = await signedIn(site, { email: requesterEmail("mod-held"), role: "moderator" });
    const page = await startAtHome(mod.context);
    const uploader = await signedIn(site, {
      email: requesterEmail("uploader-held"),
      role: "uploader",
    });
    const own = await uploader.context.newPage();
    site.dropRecording(own);
    const version1 = generatedEpub({
      workId: 42361,
      chapters: 2,
      planned: 3,
      updated: "2020-02-01",
    });
    await site.waitForUpload(
      await uploadThroughPage(site, own, uploader.userId, { name: "v1.epub", bytes: version1 }),
    );
    // Newer, with its first chapter rewritten: ingest holds it for a moderator.
    const changed = generatedEpub({
      workId: 42361,
      chapters: 3,
      planned: 3,
      updated: "2020-03-01",
      rewritten: [1],
    });
    const heldId = await uploadThroughPage(site, own, uploader.userId, {
      name: "v2.epub",
      bytes: changed,
    });
    await site.waitForUpload(heldId, "held_for_review");
    const held = await site.db
      .selectFrom("work_versions")
      .select("id")
      .where("upload_id", "=", heldId)
      .executeTakeFirstOrThrow();

    const reader = await (await site.newContext()).newPage();
    site.dropRecording(reader);
    await viaSearch(reader, "Synthetic Work 42361");
    expect(await reader.locator(".chapters a").count()).toBe(2);

    await viaHeader(page, "Admin");
    await page.getByRole("link", { name: "Works to check" }).click();
    await page.waitForURL(/\/admin\/works$/);
    const row = page.locator("tr", { hasText: "(42361)" });
    await expect.poll(() => row.innerText()).toContain("Held version");
    await row.getByRole("link").click();
    await page.getByRole("button", { name: "Approve", exact: true }).click();
    await expect
      .poll(() => page.locator("main").innerText())
      .toContain("That version is approved and now current.");

    // Readers get three chapters, and the third now reads.
    await reader.reload();
    await expect.poll(() => reader.locator(".chapters a").count()).toBe(3);
    await reader.locator(".chapters a").nth(2).click();
    await expect
      .poll(() => reader.locator("main").innerText())
      .toContain(chapterSentence(42361, 3));
    // The work has left Works to check.
    await viaHeader(page, "Admin");
    await page.getByRole("link", { name: "Works to check" }).click();
    await page.waitForURL(/\/admin\/works$/);
    await expect.poll(() => page.locator("h1").innerText()).toContain("Works to check");
    expect(await page.locator("tr", { hasText: "(42361)" }).count()).toBe(0);
    await expectLogged(site, {
      action: "approve",
      targetKind: "version",
      targetId: held.id,
      moderatorId: mod.userId,
    });
  });
});
