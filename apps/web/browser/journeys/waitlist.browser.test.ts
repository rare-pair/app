import { describe, expect, it } from "vitest";
import { expectAgentNoticeHidden } from "../harness/agent-notice";
import { useJourneySite } from "../harness/journey";
import { SITE } from "../harness/site";
import { seedLaunched, waitlistEmailCount, waitlistLink } from "../harness/waitlist";
import { byAddress, startAtHome, viaFooter } from "../harness/walk";

// This suite uses none of the AO3 work ids set aside for it (42400-42499): a wait list needs no work.
// The launch email goes on a queue with no sink here, so the unsubscribe journey seeds its row.

describe("wait list journey", () => {
  const running = useJourneySite({ prelaunch: true });

  it("The agent notice is hidden from people and screen readers", async () => {
    await expectAgentNoticeHidden(await startAtHome(await running.site.newContext()));
  });

  it("A visitor joins and confirms by the emailed link", async () => {
    const { site } = running;
    const email = "join@example.test";
    const page = await startAtHome(await site.newContext());
    expect(await page.locator("h1").innerText()).toBe("rarepair is coming soon");
    await page.getByLabel("Email address").fill(email);
    await Promise.all([
      page.waitForEvent("load"),
      page.getByRole("button", { name: "Join the wait list" }).click(),
    ]);
    expect(await page.locator("h1").innerText()).toBe("Check your email to confirm");

    const emailed = new URL(await waitlistLink(site, email));
    await byAddress(page, emailed.pathname + emailed.search, "an emailed confirmation link");
    expect(await page.locator("h1").innerText()).toBe("Confirm your address");
    // Opening the link uses nothing up: a mail scanner's prefetch can't confirm anyone.
    const opened = await site.db
      .selectFrom("waitlist")
      .select("confirmed_at")
      .where("email", "=", email)
      .executeTakeFirstOrThrow();
    expect(opened.confirmed_at).toBeNull();

    await Promise.all([
      page.waitForEvent("load"),
      page.getByRole("button", { name: "Confirm" }).click(),
    ]);
    expect(await page.locator("h1").innerText()).toBe("You're on the list");
    const row = await site.db
      .selectFrom("waitlist")
      .select(["confirmed_at", "confirm_token_hash"])
      .where("email", "=", email)
      .executeTakeFirstOrThrow();
    expect(row.confirmed_at).not.toBeNull();
    expect(row.confirm_token_hash).toBeNull();
  });

  it("A launch email's unsubscribe link removes the address", async () => {
    const { site } = running;
    const email = "unsub@example.test";
    const link = new URL(await seedLaunched(site, email));
    const page = await (await site.newContext()).newPage();
    await byAddress(page, link.pathname + link.search, "an unsubscribe link in the launch email");
    expect(await page.locator("h1").innerText()).toBe("Unsubscribe");
    const held = () =>
      site.db.selectFrom("waitlist").select("email").where("email", "=", email).executeTakeFirst();
    // Opening the link deletes nothing.
    expect(await held()).toBeDefined();
    await Promise.all([
      page.waitForEvent("load"),
      page.getByRole("button", { name: "Unsubscribe" }).click(),
    ]);
    expect(await page.locator("h1").innerText()).toBe("You're unsubscribed");
    expect(await held()).toBeUndefined();
  });

  it("A second join and a used link answer as the first do", async () => {
    const { site } = running;
    const email = "repeat@example.test";
    const page = await startAtHome(await site.newContext());
    const join = async () => {
      // The home page itself, where the form is: after the emailed links the page is elsewhere,
      // and one new page for each join would add recordings.
      await page.goto(`${SITE}/`);
      await page.getByLabel("Email address").fill(email);
      const [response] = await Promise.all([
        page.waitForResponse((r) => new URL(r.url()).pathname === "/waitlist"),
        page.waitForEvent("load"),
        page.getByRole("button", { name: "Join the wait list" }).click(),
      ]);
      return response.status();
    };
    const row = () =>
      site.db
        .selectFrom("waitlist")
        .select(["confirm_count", "confirm_sent_at", "confirmed_at"])
        .where("email", "=", email)
        .executeTakeFirstOrThrow();

    expect(await join()).toBe(200);
    const emailed = new URL(await waitlistLink(site, email));
    const linkPath = emailed.pathname + emailed.search;
    const first = await row();

    // The same page, and no second email: the address was sent one inside the hour.
    expect(await join()).toBe(200);
    expect(await page.locator("h1").innerText()).toBe("Check your email to confirm");
    const second = await row();
    expect(second.confirm_count).toBe(1);
    expect(second.confirm_sent_at).toEqual(first.confirm_sent_at);
    expect(await waitlistEmailCount(site, email)).toBe(1);

    await byAddress(page, linkPath, "an emailed confirmation link");
    await Promise.all([
      page.waitForEvent("load"),
      page.getByRole("button", { name: "Confirm" }).click(),
    ]);
    expect(await page.locator("h1").innerText()).toBe("You're on the list");

    // A confirmed address is answered the same way and gets nothing.
    expect(await join()).toBe(200);
    expect(await page.locator("h1").innerText()).toBe("Check your email to confirm");
    expect((await row()).confirm_count).toBe(1);
    expect(await waitlistEmailCount(site, email)).toBe(1);

    // The used link shows its button again, and refuses when it is pressed.
    await byAddress(page, linkPath, "the same emailed confirmation link, used");
    // Nothing logged so far was a refusal: only the one below is expected.
    await site.assertClean();
    const [refused] = await Promise.all([
      page.waitForResponse(
        (r) => new URL(r.url()).pathname === "/waitlist/confirm" && r.request().method() === "POST",
      ),
      page.waitForEvent("load"),
      page.getByRole("button", { name: "Confirm" }).click(),
    ]);
    expect(refused.status()).toBe(400);
    expect(await page.locator("h1").innerText()).toBe("That link doesn't work");
    expect(await page.locator("main").innerText()).toContain("already been used or has expired");
    await Promise.all([
      page.waitForURL(`${SITE}/`),
      page.getByRole("link", { name: "Join the wait list again" }).click(),
    ]);
    expect(await page.locator("h1").innerText()).toBe("rarepair is coming soon");

    // Chromium logs a refused page load as a console error; this is the one expected.
    await site.assertClean({ allow: [/status of 400/] });
  });

  it("Before launch the footer's Remove link and the not-found search are disabled", async () => {
    const { site } = running;
    const page = await startAtHome(await site.newContext());
    await viaFooter(page, "About");
    const footer = page.locator("footer");
    for (const name of ["Remove my work", "Copyright notice"]) {
      const link = footer.getByText(name, { exact: true });
      expect(await link.getAttribute("aria-disabled")).toBe("true");
      expect(await link.getAttribute("href")).toBeNull();
    }
    for (const name of ["Terms", "Privacy", "About"]) {
      expect(await footer.getByRole("link", { name }).getAttribute("href")).not.toBeNull();
    }
    // Tab never lands on a disabled link.
    const focused: string[] = [];
    for (let i = 0; i < 40; i++) {
      await page.keyboard.press("Tab");
      focused.push(await page.evaluate(() => document.activeElement?.textContent.trim() ?? ""));
    }
    // The loop reached the footer: its enabled links took focus.
    for (const name of ["Terms", "Privacy", "About"]) expect(focused).toContain(name);
    expect(focused).not.toContain("Remove my work");
    expect(focused).not.toContain("Copyright notice");

    const response = await byAddress(
      page,
      "/waitlist",
      "a typed address: the closed route a no-JavaScript visitor could still reach",
    );
    expect(response?.status()).toBe(404);
    await page.getByText("Search the archive").waitFor();
    expect(await page.locator("#q").isDisabled()).toBe(true);
    expect(await page.getByRole("button", { name: "Search" }).isDisabled()).toBe(true);
    expect(await page.locator("#q").evaluate((el) => getComputedStyle(el).cursor)).toBe(
      "not-allowed",
    );
    await site.assertClean({ allow: [/status of 404/] });
  });
});
