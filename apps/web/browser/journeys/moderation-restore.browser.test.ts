import { normalizePseud } from "@archive/db";
import { describe, expect, it } from "vitest";
import { useJourneySite } from "../harness/journey";
import { expectLogged, insertRequest, openRow, requesterEmail } from "../harness/moderation";
import { seedReadableWork } from "../harness/seed";
import { signedIn } from "../harness/sessions";
import type { Site } from "../harness/site";
import { byAddress, startAtHome, viaHeader } from "../harness/walk";

// A moderator brings hidden works back: rejecting a request lifts what it hid, reversing an
// opt-out lifts only its own works, and one press restores the works of a spree of requests.
// The works and requests are seeded (the requester's form and emailed link are the removal
// journeys', and ingest's the upload journeys'); the moderator's forms, and what a reader then
// gets, are the real ones. A hidden work answers 451 and a live one 200, read with `site.fetch`
// from Node so no page logs the 451. The handler rules (covered works, double decides) are the
// workerd tests'. Works take AO3 ids 42310-42311, 42320-42323 and 42330-42333.
describe("restore journeys", () => {
  const running = useJourneySite();

  const hiddenBy = (cause: "removal_request" | "moderator") => ({
    status: "hidden" as const,
    hiddenCause: cause,
  });
  /** The status a signed-out reader gets for a work's page. */
  const readerStatus = async (site: Site, ao3WorkId: number) =>
    (await site.fetch(`/works/${ao3WorkId}`)).status;

  it("Rejecting a request restores the work it hid", async () => {
    const { site } = running;
    const mod = await signedIn(site, { email: requesterEmail("mod-reject"), role: "moderator" });
    const page = await startAtHome(mod.context);
    const hid = await seedReadableWork(site, {
      ao3WorkId: 42310,
      title: "Synthetic Work 42310",
      ...hiddenBy("removal_request"),
    });
    // Hidden by a moderator, not by the request: a reject doesn't touch it.
    await seedReadableWork(site, {
      ao3WorkId: 42311,
      title: "Synthetic Work 42311",
      ...hiddenBy("moderator"),
    });
    const requestId = await insertRequest(site, {
      workId: hid.workId,
      email: requesterEmail("requester-reject"),
      hid: [hid.workId],
    });
    expect(await readerStatus(site, 42310)).toBe(451);

    await viaHeader(page, "Admin");
    await page.getByRole("link", { name: "Requests" }).click();
    await page.waitForURL(/\/admin\/requests$/);
    await openRow(page, "(42310)");
    await page.getByRole("button", { name: "Reject", exact: true }).click();
    await expect.poll(() => page.locator("main").innerText()).toContain("1 work is live again.");

    expect(await readerStatus(site, 42310)).toBe(200);
    expect(await readerStatus(site, 42311)).toBe(451);
    const request = await site.db
      .selectFrom("requests")
      .select("status")
      .where("id", "=", requestId)
      .executeTakeFirstOrThrow();
    expect(request.status).toBe("rejected");
    // The note names the work it brought back, by its AO3 id.
    const note = await expectLogged(site, {
      action: "reject",
      targetKind: "request",
      targetId: requestId,
      moderatorId: mod.userId,
    });
    expect(note).toContain("42310");
  });

  it("Reversing an opt-out restores only its own works", async () => {
    const { site } = running;
    const mod = await signedIn(site, { email: requesterEmail("mod-optout"), role: "moderator" });
    const page = await startAtHome(mod.context);
    const byPseud = { authors: [{ pseud: "Pw6 Opt Out Pseud", ao3_user: null }] };
    const [a, b, c, d] = [42320, 42321, 42322, 42323];
    const own = (ao3WorkId: number, cause: "removal_request" | "moderator") =>
      seedReadableWork(site, {
        ao3WorkId,
        title: `Synthetic Work ${ao3WorkId}`,
        ...byPseud,
        ...hiddenBy(cause),
      });
    const workA = await own(a, "removal_request");
    const workB = await own(b, "removal_request");
    // C is by the same pseud but a moderator hid it: the opt-out never did.
    await own(c, "moderator");
    const workD = await own(d, "removal_request");
    const optOutId = await insertRequest(site, {
      kind: "opt_out",
      pseudNorm: normalizePseud("Pw6 Opt Out Pseud"),
      email: requesterEmail("requester-optout"),
      status: "approved",
      hid: [workA.workId, workB.workId, workD.workId],
    });
    await site.db
      .insertInto("optouts")
      .values({
        pseud_norm: normalizePseud("Pw6 Opt Out Pseud"),
        request_id: optOutId,
        active: true,
      })
      .execute();
    // Another requester's confirmed removal request for D is still pending: it still covers D.
    await insertRequest(site, { workId: workD.workId, email: requesterEmail("requester-other") });
    for (const id of [a, b, c, d]) expect(await readerStatus(site, id)).toBe(451);

    // An approved opt-out is no longer in the queue: its page is where Reverse opt-out is, and
    // no page links to it (the related-requests list needs a shared email or IP hash, which this
    // opt-out and the other requester don't share). Reversing an approved opt-out has no way in
    // until #591.
    await byAddress(
      page,
      `/admin/requests/${optOutId}`,
      "an approved opt-out is in no queue (#591)",
    );
    await page.getByRole("button", { name: "Reverse opt-out" }).click();
    await expect
      .poll(() => page.locator("main").innerText())
      .toContain("The opt-out is no longer active. 2 works are live again.");

    expect(await readerStatus(site, a)).toBe(200);
    expect(await readerStatus(site, b)).toBe(200);
    expect(await readerStatus(site, c)).toBe(451);
    expect(await readerStatus(site, d)).toBe(451);
    const optOut = await site.db
      .selectFrom("optouts")
      .select("active")
      .where("request_id", "=", optOutId)
      .executeTakeFirstOrThrow();
    expect(optOut.active).toBe(false);
    const note = await expectLogged(site, {
      action: "reject",
      targetKind: "request",
      targetId: optOutId,
      moderatorId: mod.userId,
    });
    expect(note).toContain("Opt-out reversed.");
  });

  it("Restoring related works brings back every work a spree hid", async () => {
    const { site } = running;
    const mod = await signedIn(site, { email: requesterEmail("mod-bulk"), role: "moderator" });
    const page = await startAtHome(mod.context);
    const spree = { email: requesterEmail("requester-spree"), ipHash: "pw6-ip-spree" };
    const ids = [42330, 42331, 42332];
    const requests: string[] = [];
    for (const id of ids) {
      const work = await seedReadableWork(site, {
        ao3WorkId: id,
        title: `Synthetic Work ${id}`,
        ...hiddenBy("removal_request"),
      });
      requests.push(
        await insertRequest(site, { workId: work.workId, ...spree, hid: [work.workId] }),
      );
    }
    // From someone else: not in the spree, and its work stays hidden.
    const other = await seedReadableWork(site, {
      ao3WorkId: 42333,
      title: "Synthetic Work 42333",
      ...hiddenBy("removal_request"),
    });
    const otherRequest = await insertRequest(site, {
      workId: other.workId,
      email: requesterEmail("requester-unrelated"),
      hid: [other.workId],
    });

    await viaHeader(page, "Admin");
    await page.getByRole("link", { name: "Requests" }).click();
    await page.waitForURL(/\/admin\/requests$/);
    await openRow(page, "(42330)");
    // The page lists the spree's other requests, and not the unrelated one.
    const related = page.locator("table", {
      hasText: "Requests from the same contact email or IP",
    });
    await expect.poll(() => related.innerText()).toContain("(42331)");
    const listed = await related.innerText();
    expect(listed).toContain("(42332)");
    expect(listed).not.toContain("(42333)");
    await page
      .getByRole("button", { name: "Restore related works (rejects their pending requests)" })
      .click();
    await expect
      .poll(() => page.locator("main").innerText())
      .toContain("3 works are live again. 3 pending requests were rejected.");

    for (const id of ids) expect(await readerStatus(site, id)).toBe(200);
    expect(await readerStatus(site, 42333)).toBe(451);
    const statuses = await site.db
      .selectFrom("requests")
      .select(["id", "status"])
      .where("id", "in", [...requests, otherRequest])
      .execute();
    expect(
      statuses
        .filter((r) => r.status === "rejected")
        .map((r) => r.id)
        .sort(),
    ).toEqual([...requests].sort());
    for (const id of requests) {
      await expectLogged(site, {
        action: "reject",
        targetKind: "request",
        targetId: id,
        moderatorId: mod.userId,
      });
    }
  });
});
