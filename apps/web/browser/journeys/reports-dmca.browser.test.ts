import { describe, expect, it } from "vitest";
import { useJourneySite } from "../harness/journey";
import { seedReadableWork } from "../harness/seed";
import { signedIn } from "../harness/sessions";
import { SITE, type Site } from "../harness/site";

// A DMCA notice reaching the takedowns queue, and three accounts' reports hiding a work, through
// the real forms. Works here take AO3 ids 42220 (notice) and 42240 (reports).

describe("reports and notices journeys", () => {
  const running = useJourneySite();

  it("A DMCA notice is stored and reaches the takedowns queue", async () => {
    const { site } = running;
    await seedReadableWork(site, { ao3WorkId: 42220, title: "pw5-Noticed work" });
    const notice = await (await site.newContext()).newPage();

    await notice.goto(`${SITE}/dmca`);
    await notice.getByLabel("The work here", { exact: false }).fill("42220");
    await notice
      .getByLabel("The copyrighted work you say is infringed", { exact: false })
      .fill("A synthetic original, pw5-copyrighted.");
    await notice
      .getByLabel("The material you say infringes it", { exact: false })
      .fill("The whole of it, pw5-infringing.");
    await notice
      .getByLabel("Your name, address", { exact: false })
      .fill("Pw5 Owner, pw5-owner@example.test");
    await notice.getByLabel("I have a good-faith belief", { exact: false }).check();
    await notice.getByLabel("The information in this notice is accurate", { exact: false }).check();
    await notice.getByLabel("Your full name, as your signature").fill("Pw5 Owner");
    await Promise.all([
      notice.waitForEvent("load"),
      notice.getByRole("button", { name: "Send notice" }).click(),
    ]);
    expect(await notice.locator("main").innerText()).toContain("Notice received");

    // Unlike a removal request, a notice hides nothing: the work stays up until a moderator decides.
    const reader = await (await site.newContext()).newPage();
    site.dropRecording(reader);
    expect((await reader.goto(`${SITE}/works/42220`))?.status()).toBe(200);

    // The queue is the moderator's result, so it stays on video.
    const moderator = await signedIn(site, {
      email: "pw5-mod-takedowns@example.test",
      role: "moderator",
    });
    const page = await moderator.context.newPage();
    await page.goto(`${SITE}/admin/takedowns`);
    const row = page.locator("tr", { hasText: "pw5-Noticed work" });
    await expect.poll(() => row.count()).toBe(1);
    const text = await row.innerText();
    expect(text).toContain("pw5-owner@example.test");
    expect(text).toContain("pw5-infringing");
    expect(text).toContain("Pw5 Owner");
    expect(text).toContain("good faith, accuracy");
    expect(text).not.toContain("Incomplete");
    await row.getByRole("link").first().click();
    await page.waitForURL(/\/admin\/takedowns\/[\w-]+/);
    expect(await page.locator("main").innerText()).toContain("pw5-copyrighted");
  });

  it("Reports from three accounts hide a work", async () => {
    const { site } = running;
    await seedReadableWork(site, { ao3WorkId: 42240, title: "pw5-Reported work" });

    /** Signs a new account in and has it report work 42240 for "Something else". */
    const report = async (n: number, record: boolean) => {
      const { context } = await signedIn(site, { email: `pw5-reporter${n}@example.test` });
      const page = await context.newPage();
      // The first two reporters are setup; the third's page is the journey.
      if (!record) site.dropRecording(page);
      await page.goto(`${SITE}/works/42240`);
      await page.getByRole("link", { name: "Report", exact: true }).click();
      await page.waitForURL(/\/works\/42240\/report/);
      await page.getByLabel("Something else").check();
      await page.getByLabel("Details", { exact: false }).fill(`pw5 report ${n}`);
      await Promise.all([
        page.waitForEvent("load"),
        page.getByRole("button", { name: "Send report" }).click(),
      ]);
      expect(await page.locator("main").innerText()).toContain("Report sent");
      return page;
    };

    await report(1, false);
    await report(2, false);
    // Both reports are on file, and two are not enough to hide it.
    const filed = await site.db
      .selectFrom("reports")
      .innerJoin("works", "works.id", "reports.work_id")
      .select("reports.id")
      .where("works.ao3_work_id", "=", 42240)
      .execute();
    expect(filed).toHaveLength(2);
    await stillLive(site);
    const page = await report(3, true);

    const res = await page.goto(`${SITE}/works/42240`);
    expect(res?.status()).toBe(451);
    expect(await page.locator("main").innerText()).toContain(
      "Temporarily hidden after reader reports",
    );
    await site.assertClean({ allow: [/status of 451/] });
  });
});

/** After two reports the work is still up. */
async function stillLive(site: Site) {
  const reader = await (await site.newContext()).newPage();
  site.dropRecording(reader);
  expect((await reader.goto(`${SITE}/works/42240`))?.status()).toBe(200);
}
