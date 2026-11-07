import { describe, expect, it } from "vitest";
import { useJourneySite } from "../harness/journey";
import { hasSidewaysScroll } from "../harness/layout";
import { expectLogged, openRow, requesterEmail } from "../harness/moderation";
import { seedReadableWork } from "../harness/seed";
import { signedIn } from "../harness/sessions";
import { startAtHome, viaHeader, viaSearch } from "../harness/walk";

// A reader's report that a work needs a higher rating, and the moderator who marks it as adult
// from the work's admin page. The work and the report are seeded; the moderator's forms are the
// real ones. The work takes AO3 id 60870.
describe("adult mark journeys", () => {
  const running = useJourneySite();

  it("A moderator marks a reported work as adult, and its readers meet the warnings screen", async () => {
    const { site } = running;
    const mod = await signedIn(site, { email: requesterEmail("mod-adult"), role: "moderator" });
    const work = await seedReadableWork(site, { ao3WorkId: 60870, title: "Synthetic Work 60870" });
    await site.db
      .insertInto("reports")
      .values({ work_id: work.workId, reporter_id: work.userId, kind: "higher_rating" })
      .execute();

    const page = await startAtHome(mod.context);
    await viaHeader(page, "Admin");
    await page.getByRole("link", { name: "Reports" }).click();
    await page.waitForURL(/\/admin\/reports$/);
    await openRow(page, "(60870)");
    await page.waitForURL(/\/admin\/reports\/[^/]+$/);
    await page.getByRole("link", { name: "The work's admin page" }).click();
    await page.waitForURL(/\/admin\/works\/60870$/);
    expect(await hasSidewaysScroll(page)).toBe(false);

    await page.getByRole("button", { name: "Mark as adult" }).click();
    await expect.poll(() => page.locator("main").innerText()).toContain("Marked as adult.");
    await expectLogged(site, {
      action: "mark_adult",
      targetKind: "work",
      targetId: work.workId,
      moderatorId: mod.userId,
    });

    // A reader opening the work is sent to the screen, which says why.
    const reader = await startAtHome(await site.newContext());
    site.dropRecording(reader);
    await viaSearch(reader, "Synthetic Work 60870");
    await reader.locator("ol.chapters a").first().click();
    await reader.waitForURL(/\/works\/60870\/warnings/);
    expect(await reader.locator("main").innerText()).toContain(
      "A moderator marked this work as adult.",
    );
  });
});
