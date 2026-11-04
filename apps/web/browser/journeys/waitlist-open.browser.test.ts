import { describe, expect, it } from "vitest";
import { useJourneySite } from "../harness/journey";
import { SITE } from "../harness/site";
import { seedLaunched } from "../harness/waitlist";

// This suite uses none of the AO3 work ids set aside for it (42400-42499): a wait list needs no work.

describe("wait list after launch journey", () => {
  const running = useJourneySite();

  it("With the archive open the wait list links show the archive-open page", async () => {
    const { site } = running;
    const page = await (await site.newContext()).newPage();
    const response = await page.goto(`${SITE}/waitlist/confirm?token=${"A".repeat(43)}`);
    expect(response?.status()).toBe(200);
    expect(await page.locator("h1").innerText()).toBe("The archive is open");
    expect(await page.locator("main").innerText()).toContain("the wait list is closed");
    await Promise.all([
      page.waitForURL(`${SITE}/`),
      page.getByRole("link", { name: "Go to the archive" }).click(),
    ]);
    expect(await page.locator("form.waitlist").count()).toBe(0);

    await page.goto(`${SITE}/waitlist`);
    expect(new URL(page.url()).pathname).toBe("/");
  });

  it("An unsubscribe link still works after launch", async () => {
    const { site } = running;
    const email = "late@example.test";
    const link = await seedLaunched(site, email);
    const page = await (await site.newContext()).newPage();
    await page.goto(link);
    await Promise.all([
      page.waitForEvent("load"),
      page.getByRole("button", { name: "Unsubscribe" }).click(),
    ]);
    expect(await page.locator("h1").innerText()).toBe("You're unsubscribed");
    const held = await site.db
      .selectFrom("waitlist")
      .select("email")
      .where("email", "=", email)
      .executeTakeFirst();
    expect(held).toBeUndefined();
  });
});
