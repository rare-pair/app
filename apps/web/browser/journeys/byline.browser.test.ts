import { describe, expect, it } from "vitest";
import { uploadThroughPage, useJourneySite } from "../harness/journey";
import { signedIn } from "../harness/sessions";
import { SITE } from "../harness/site";
import { generatedEpub } from "./epubs";

// A byline ingest can't read as one pseud (the operator's ruling on #276): the work goes live, and
// is flagged in Works to check rather than refused. Works here take AO3 ids 42230 and 42231; the
// names are unique to this file, since an opt-out anywhere else on a site would match them.

const profile = (name: string, text: string) =>
  `<a href="http://archiveofourown.org/users/${name}/pseuds/${name}" rel="author">${text}</a>`;

describe("byline journeys", () => {
  const running = useJourneySite();

  const cases = [
    {
      title: "A blank byline goes live flagged in Works to check",
      workId: 42230,
      email: "pw5-blank@example.test",
      reason: "byline_missing",
      epub: () => generatedEpub({ workId: 42230, bylineHtml: profile("pw5x", " "), creators: [] }),
    },
    {
      title: "An ambiguous byline goes live flagged in Works to check",
      workId: 42231,
      email: "pw5-ambiguous@example.test",
      reason: "byline_ambiguous",
      epub: () =>
        generatedEpub({ workId: 42231, bylineHtml: "Pw5Salt and Pw5Pepper", creators: [] }),
    },
  ];

  for (const { title, workId, email, reason, epub } of cases) {
    it(title, async () => {
      const { site } = running;
      const { context, userId } = await signedIn(site, { email, role: "uploader" });
      const page = await context.newPage();
      // The uploader's page is setup here; the moderator's check of the queue is the journey.
      site.dropRecording(page);
      await site.waitForUpload(
        await uploadThroughPage(site, page, userId, { name: `${workId}.epub`, bytes: epub() }),
        "live",
      );

      // A reader sees the work, with the notice that it may be imperfect.
      const reader = await (await site.newContext()).newPage();
      const res = await reader.goto(`${SITE}/works/${workId}`);
      expect(res?.status()).toBe(200);
      expect(await reader.locator("main").innerText()).toContain(
        "Chapters may be imperfect; a moderator will check.",
      );

      const moderator = await signedIn(site, {
        email: `${email.replace("@", "-mod@")}`,
        role: "moderator",
      });
      const queue = await moderator.context.newPage();
      await queue.goto(`${SITE}/admin/works`);
      const row = queue.locator("tr", { hasText: `(${workId})` });
      await expect.poll(() => row.count()).toBe(1);
      // The one reason, with no other after it.
      expect(await row.innerText()).toMatch(new RegExp(`Review reasons: ${reason}(\\s|$)`));
    });
  }
});
