import { describe, expect, it } from "vitest";
import { useJourneySite } from "../harness/journey";
import { hasSidewaysScroll } from "../harness/layout";
import { expectLogged, insertRequest, openRow, requesterEmail } from "../harness/moderation";
import { seedReadableWork } from "../harness/seed";
import { signedIn } from "../harness/sessions";
import { startAtHome, viaHeader } from "../harness/walk";

// A moderator closes a report that has no merit, and a rejected removal request leaves a work's
// reports for a moderator to read. The works, reports and requests are seeded; the moderator's
// forms are the real ones. Works take AO3 ids 60860-60861.
describe("dismiss journeys", () => {
  const running = useJourneySite();

  it("A moderator dismisses a report, by keyboard", async () => {
    const { site } = running;
    const mod = await signedIn(site, { email: requesterEmail("mod-dismiss"), role: "moderator" });
    const work = await seedReadableWork(site, { ao3WorkId: 60860, title: "Synthetic Work 60860" });
    const { id } = await site.db
      .insertInto("reports")
      .values({ work_id: work.workId, reporter_id: work.userId, kind: "other" })
      .returning("id")
      .executeTakeFirstOrThrow();

    const page = await startAtHome(mod.context);
    await viaHeader(page, "Admin");
    await page.getByRole("link", { name: "Reports" }).click();
    await page.waitForURL(/\/admin\/reports$/);
    await openRow(page, "(60860)");
    await page.waitForURL(/\/admin\/reports\/[^/]+$/);
    expect(await hasSidewaysScroll(page)).toBe(false);

    await page.getByRole("button", { name: "Dismiss report" }).focus();
    await page.keyboard.press("Enter");
    await expect.poll(() => page.locator("main").innerText()).toContain("Report dismissed.");

    await page.getByRole("link", { name: "Back to the item" }).click();
    expect(await page.locator("main").innerText()).toContain("closed");
    expect(await page.getByRole("button", { name: "Dismiss report" }).count()).toBe(0);
    await expectLogged(site, {
      action: "dismiss",
      targetKind: "report",
      targetId: id,
      moderatorId: mod.userId,
    });
    expect((await site.fetch("/works/60860")).status).toBe(200);
  });

  it("Rejecting a removal request leaves the work's report in the queue", async () => {
    const { site } = running;
    const mod = await signedIn(site, { email: requesterEmail("mod-kept"), role: "moderator" });
    const work = await seedReadableWork(site, {
      ao3WorkId: 60861,
      title: "Synthetic Work 60861",
      status: "hidden",
      hiddenCause: "removal_request",
    });
    await site.db
      .insertInto("reports")
      .values({ work_id: work.workId, reporter_id: work.userId, kind: "other" })
      .execute();
    await insertRequest(site, {
      workId: work.workId,
      email: requesterEmail("requester-kept"),
      hid: [work.workId],
    });

    const page = await startAtHome(mod.context);
    await viaHeader(page, "Admin");
    await page.getByRole("link", { name: "Requests" }).click();
    await page.waitForURL(/\/admin\/requests$/);
    await openRow(page, "(60861)");
    await page.getByRole("button", { name: "Reject", exact: true }).click();
    await expect.poll(() => page.locator("main").innerText()).toContain("1 work is live again.");

    await viaHeader(page, "Admin");
    await page.getByRole("link", { name: "Reports" }).click();
    await page.waitForURL(/\/admin\/reports$/);
    expect(await page.locator("tr", { hasText: "(60861)" }).count()).toBe(1);
    expect((await site.fetch("/works/60861")).status).toBe(200);
  });
});
