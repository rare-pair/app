import { sql } from "kysely";
import { describe, expect, it } from "vitest";
import { sendFiles, uploadFilesThroughPage, useJourneySite } from "../harness/journey";
import { signedIn } from "../harness/sessions";
import { generatedEpub } from "./epubs";

// The daily upload quota, as the uploader sees it. Works here take AO3 ids 41930 to 41934.
describe("quota journey", () => {
  const running = useJourneySite();

  it("Over the daily quota, the page says how many are left", async () => {
    const { site } = running;
    const { context, userId } = await signedIn(site, {
      email: "pw2-quota@example.test",
      role: "uploader",
    });
    // The quota is a counter on the user row, so start 98 of 100 in: two uploads left today. The
    // day is the database's UTC date, as the app reads it; a run that straddles midnight UTC
    // could see the counter reset, a rare flake we accept.
    await site.db
      .updateTable("user")
      .set({ upload_quota_used: 98, upload_quota_day: sql`(now() at time zone 'utc')::date` })
      .where("id", "=", userId)
      .execute();
    const page = await context.newPage();
    const file = (workId: number) => ({
      name: `work-${workId}.epub`,
      bytes: generatedEpub({ workId }),
    });
    const uploadCount = async () =>
      Number(
        (
          await site.db
            .selectFrom("uploads")
            .select((eb) => eb.fn.countAll().as("n"))
            .where("user_id", "=", userId)
            .executeTakeFirstOrThrow()
        ).n,
      );

    // Three picked, two left: nothing is sent, and the page says how many can be.
    await sendFiles(page, [file(41930), file(41931), file(41932)]);
    await expect
      .poll(() => page.locator("#message").innerText())
      .toBe(
        "You have 2 uploads left today, and you picked more. Pick 2 or fewer, or wait until midnight UTC for the quota to reset.",
      );
    await expect
      .poll(() => page.locator("#files li").allInnerTexts())
      .toEqual([
        expect.stringContaining("Not uploaded."),
        expect.stringContaining("Not uploaded."),
        expect.stringContaining("Not uploaded."),
      ]);
    expect(await uploadCount()).toBe(0);

    // Two fit: they upload and go live.
    const ids = await uploadFilesThroughPage(site, page, userId, [file(41930), file(41931)]);
    await Promise.all(ids.map((id) => site.waitForUpload(id)));

    // One more is over: the quota is spent, and the page says when it resets.
    await sendFiles(page, [file(41932)]);
    await expect.poll(() => page.locator("#message").innerText()).toMatch(/resets at midnight UTC/);
    await expect.poll(() => page.locator("#files li").innerText()).toContain("Not uploaded.");
    expect(await uploadCount()).toBe(2);

    // Each 429 is logged by Chromium as a failed load.
    await site.assertClean({ allow: [/status of 429/] });
  });

  it("With too many unfinished uploads, the page says what to do", async () => {
    const { site } = running;
    const { context, userId } = await signedIn(site, {
      email: "uploadcap-open@example.test",
      role: "uploader",
    });
    // Links asked for and never finished: 99 of the 100 the account may hold open, seeded in one insert.
    await site.db
      .insertInto("uploads")
      .values(
        Array.from({ length: 99 }, () => {
          const id = crypto.randomUUID();
          return { id, user_id: userId, r2_key: `uploads/${id}`, bytes: 1000 };
        }),
      )
      .execute();
    const page = await context.newPage();
    const file = (workId: number) => ({
      name: `work-${workId}.epub`,
      bytes: generatedEpub({ workId }),
    });

    await sendFiles(page, [file(60000), file(60001)]);
    await expect
      .poll(() => page.locator("#message").innerText())
      .toBe(
        "You have too many unfinished uploads to start all of these. You can start 1 more now. Unfinished uploads clear by themselves after about a day, so please try again then.",
      );
    await expect
      .poll(() => page.locator("#files li").allInnerTexts())
      .toEqual([
        expect.stringContaining("Not uploaded."),
        expect.stringContaining("Not uploaded."),
      ]);

    // The one that fits goes up, signed for its own size, and goes live.
    const [id] = await uploadFilesThroughPage(site, page, userId, [file(60000)]);
    await site.waitForUpload(id);

    await site.assertClean({ allow: [/status of 429/] });
  });
});
