import type { Page } from "playwright";
import { describe, expect, it } from "vitest";
import { uploadThroughPage, useJourneySite } from "../harness/journey";
import { removalLink } from "../harness/requests";
import { seedReadableWork } from "../harness/seed";
import { signedIn } from "../harness/sessions";
import { SITE } from "../harness/site";
import { byAddress, startAtHome, viaFooter, viaHeader } from "../harness/walk";
import { generatedEpub } from "./epubs";

// Removal requests and the opt-out, through the real forms: nothing is hidden until the
// requester confirms the emailed link, then the work's pages answer 451; an opted-out pseud's
// later upload is refused by real ingest. The requester is signed out, as they are in life.
// Works here take AO3 ids 42200 and 42201 (removal), 42210 to 42213 (opt-out).

const HIDDEN_LINE = "Temporarily hidden after a removal request";

/** Fills the /remove form as a visitor does and sends it; returns once the next page loads. */
async function sendRemoval(
  page: Page,
  {
    email,
    work,
    pseud,
    statement,
  }: Record<"email" | "statement", string> & Partial<Record<"work" | "pseud", string>>,
) {
  await page.getByLabel("Your email address").fill(email);
  if (work !== undefined)
    await page.getByLabel("The work's web address", { exact: false }).fill(work);
  if (pseud !== undefined)
    await page.getByLabel("Or a pseud, to remove every work by it").fill(pseud);
  await page.getByLabel("A short statement", { exact: false }).fill(statement);
  // The Turnstile stand-in has put its token in the form once its widget is solved.
  await page.waitForFunction(
    () => document.querySelector<HTMLInputElement>(`input[name="cf-turnstile-response"]`)?.value,
  );
  await Promise.all([
    page.waitForEvent("load"),
    page.getByRole("button", { name: "Send request" }).click(),
  ]);
}

/** Opens the emailed link and presses Confirm, as the requester does. */
async function confirmByLink(page: Page, link: string) {
  await page.goto(link);
  // Opening the link only shows a button: nothing is confirmed until it is pressed.
  expect(await page.getByRole("button", { name: "Confirm" }).count()).toBe(1);
  await Promise.all([
    page.waitForEvent("load"),
    page.getByRole("button", { name: "Confirm" }).click(),
  ]);
}

const mainText = (page: Page) => page.locator("main").innerText();

describe("removal and opt-out journeys", () => {
  const running = useJourneySite();

  it("A removal request hides nothing until the emailed link is confirmed, then the work answers 451", async () => {
    const { site } = running;
    await seedReadableWork(site, {
      ao3WorkId: 42200,
      title: "pw5-Removal work",
      chapters: [
        { title: "Chapter 1", html: "<p>Synthetic text of pw5 removal.</p>", words: 5 },
        { title: "Chapter 2", html: "<p>More synthetic text of pw5 removal.</p>", words: 5 },
      ],
      chapterTotal: 2,
    });
    const email = "pw5-removal@example.test";
    const page = await startAtHome(await site.newContext());

    // From the home page's recent works to the work, and its link to ask for removal.
    await page.locator(".card-title").getByRole("link", { name: "pw5-Removal work" }).click();
    await page.waitForURL(/\/works\/42200$/);
    await page.getByRole("link", { name: "Ask for this to be removed" }).click();
    await page.waitForURL(/\/remove\?work=42200/);
    await sendRemoval(page, { email, statement: "A synthetic statement for the moderators." });
    expect(await mainText(page)).toContain("Check your email");

    // Asking changed nothing: the work and its chapters are still there.
    const still = await page.goto(`${SITE}/works/42200`);
    expect(still?.status()).toBe(200);
    expect(await page.locator(".chapters a").count()).toBe(2);

    await confirmByLink(page, await removalLink(site, email));
    expect(await mainText(page)).toContain("Your request is confirmed");

    for (const path of ["", "/chapters/1", "/full"]) {
      // A hidden work is listed nowhere, so nothing links to its pages.
      const res = await byAddress(page, `/works/42200${path}`, "a hidden work is listed nowhere");
      expect(res?.status(), path).toBe(451);
      const text = await mainText(page);
      expect(text, path).toContain(HIDDEN_LINE);
      expect(text, path).not.toContain("pw5-Removal work");
    }
    // Chromium logs a console error for each non-2xx navigation; the 451s only.
    await site.assertClean({ allow: [/status of 451/] });
  });

  it("An unconfirmed request stays visible to moderators and does nothing else", async () => {
    const { site } = running;
    await seedReadableWork(site, { ao3WorkId: 42201, title: "pw5-Unconfirmed work" });
    const email = "pw5-unconfirmed@example.test";
    const requester = await startAtHome(await site.newContext());
    // The work's own link keeps the prefill that the footer's would lose.
    await requester
      .locator(".card-title")
      .getByRole("link", { name: "pw5-Unconfirmed work" })
      .click();
    await requester.waitForURL(/\/works\/42201$/);
    await requester.getByRole("link", { name: "Ask for this to be removed" }).click();
    await requester.waitForURL(/\/remove\?work=42201/);
    await sendRemoval(requester, { email, statement: "pw5 unconfirmed statement" });
    expect(await mainText(requester)).toContain("Check your email");

    const moderator = await signedIn(site, {
      email: "pw5-mod-unconfirmed@example.test",
      role: "moderator",
    });
    const page = await startAtHome(moderator.context);
    await viaHeader(page, "Admin");
    await page.getByRole("link", { name: "Requests" }).click();
    await page.waitForURL(/\/admin\/requests$/);
    const row = page.locator("tr", { hasText: email });
    await expect.poll(() => row.innerText()).toContain("remove_work (unconfirmed)");
    expect(await row.innerText()).toContain("pw5-Unconfirmed work");
    await row.getByRole("link").first().click();
    await page.waitForURL(/\/admin\/requests\/[\w-]+/);
    // Nothing to approve until the requester confirms; the moderator can only reject.
    expect(await page.getByRole("button", { name: "Reject", exact: true }).count()).toBe(1);
    expect(await page.getByRole("button", { name: /^Approve/ }).count()).toBe(0);

    const reader = await (await site.newContext()).newPage();
    site.dropRecording(reader);
    // Nothing was hidden: every page of the work still answers 200.
    for (const path of ["", "/chapters/1", "/full"]) {
      expect((await reader.goto(`${SITE}/works/42201${path}`))?.status(), path).toBe(200);
    }
  });

  it("An opt-out hides every work by the pseud, and a later upload by that pseud is refused", async () => {
    const { site } = running;
    const byPseud = { authors: [{ pseud: "Pw5Moon", ao3_user: "pw5moon" }] };
    await seedReadableWork(site, { ao3WorkId: 42210, title: "pw5-Moon one", ...byPseud });
    await seedReadableWork(site, { ao3WorkId: 42211, title: "pw5-Moon two", ...byPseud });
    await seedReadableWork(site, {
      ao3WorkId: 42212,
      title: "pw5-Sun one",
      authors: [{ pseud: "Pw5Sun", ao3_user: "pw5sun" }],
    });
    const email = "pw5-optout@example.test";
    const page = await startAtHome(await site.newContext());

    await viaFooter(page, "Remove my work");
    // A different case from the pseud's own: the request is matched without it.
    await sendRemoval(page, { email, pseud: "pw5moon", statement: "A synthetic opt-out." });
    expect(await mainText(page)).toContain("Check your email");
    // Nothing is hidden until the link is confirmed.
    expect((await page.goto(`${SITE}/works/42210`))?.status()).toBe(200);

    await confirmByLink(page, await removalLink(site, email));
    expect(await mainText(page)).toContain("Your request is confirmed");

    for (const id of [42210, 42211]) {
      const res = await byAddress(page, `/works/${id}`, "a hidden work is listed nowhere");
      expect(res?.status(), String(id)).toBe(451);
      expect(await mainText(page)).toContain(HIDDEN_LINE);
    }
    // Another pseud's work is untouched.
    expect((await page.goto(`${SITE}/works/42212`))?.status()).toBe(200);

    // A later upload by the pseud goes through real ingest, which refuses it.
    const { context, userId } = await signedIn(site, {
      email: "pw5-optout-uploader@example.test",
      role: "uploader",
    });
    const uploader = await context.newPage();
    const id = await uploadThroughPage(site, uploader, userId, {
      name: "moon.epub",
      bytes: generatedEpub({ workId: 42213, pseud: "Pw5Moon" }),
    });
    await site.waitForUpload(id, "opted_out");
    await viaHeader(uploader, "My uploads");
    const row = uploader.locator(`li[data-upload-id="${id}"]`);
    await expect.poll(() => row.locator(".badge").innerText()).toBe("Rejected");
    await expect
      .poll(() => row.locator(".upload-message").innerText())
      .toContain("This work can't be added to the archive.");
    const stored = await site.db
      .selectFrom("works")
      .select("id")
      .where("ao3_work_id", "=", 42213)
      .execute();
    expect(stored).toEqual([]);
    await site.assertClean({ allow: [/status of 451/] });
  });
});
