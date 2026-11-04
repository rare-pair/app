import { insertUpload } from "@archive/db";
import { describe, expect, it } from "vitest";
import { DUMMY_TOKEN } from "../../test/stand-ins";
import { useJourneySite } from "../harness/journey";
import {
  confirmationToken,
  expectLogged,
  insertRequest,
  requesterEmail,
} from "../harness/moderation";
import { seedReadableWork } from "../harness/seed";
import { signedIn } from "../harness/sessions";
import { SITE } from "../harness/site";

// A moderator acts on a person: blocking a requester, and banning an uploader. Blocking is checked
// where it takes effect, when the requester presses their emailed link (confirmRequest reads the
// blocks then, from the stored request, not from the browser), so the second request is seeded
// unconfirmed with a token we hold and confirmed through the real /remove/confirm page; the
// emailed link and the /remove form are the removal journeys'. Banning ends an account's pending
// uploads as account_banned and refuses a new one with 403 and no row: the ticket says a banned
// uploader's "new uploads end account_banned", but what ships is that a new upload is refused
// and only a pending one ends so (ARCHITECTURE, Moderation; 18-ban-uploader). A job ingest is
// already running when the ban lands ends account_banned at its next check, and that is the
// ingest tests' (a race this harness can't hit on purpose). Works take AO3 ids 42340-42341 and
// 42350.
describe("account journeys", () => {
  const running = useJourneySite();

  it("A blocked requester's confirmed request only queues", async () => {
    const { site } = running;
    const mod = await signedIn(site, { email: requesterEmail("mod-block"), role: "moderator" });
    const page = await mod.context.newPage();
    const spree = { email: requesterEmail("requester-block"), ipHash: "pw6-ip-block" };
    const first = await seedReadableWork(site, {
      ao3WorkId: 42340,
      title: "Synthetic Work 42340",
      status: "hidden",
      hiddenCause: "removal_request",
    });
    const firstRequest = await insertRequest(site, {
      workId: first.workId,
      ...spree,
      hid: [first.workId],
    });
    // The same requester's second request, made before the block and not yet confirmed.
    const second = await seedReadableWork(site, {
      ao3WorkId: 42341,
      title: "Synthetic Work 42341",
    });
    const { token, hash } = await confirmationToken();
    const secondRequest = await insertRequest(site, {
      workId: second.workId,
      ...spree,
      confirmTokenHash: hash,
    });

    await page.goto(`${SITE}/admin/requests`);
    await page.locator("tr", { hasText: "(42340)" }).getByRole("link").click();
    await page.getByRole("button", { name: "Block requester" }).click();
    await expect.poll(() => page.locator("main").innerText()).toContain("Requester blocked.");

    // The requester presses their link, in a browser of their own.
    const requester = await (await site.newContext()).newPage();
    site.dropRecording(requester);
    await requester.goto(`${SITE}/remove/confirm?token=${token}`);
    await requester.getByRole("button", { name: "Confirm" }).click();
    await expect
      .poll(() => requester.locator("main").innerText())
      .toContain("Your request is confirmed.");

    // The link was spent and the request is confirmed, but nothing was hidden.
    expect((await site.fetch("/works/42341")).status).toBe(200);
    const row = await site.db
      .selectFrom("requests")
      .select(["status", "confirmed_at", "confirm_token_hash"])
      .where("id", "=", secondRequest)
      .executeTakeFirstOrThrow();
    expect(row.status).toBe("pending");
    expect(row.confirmed_at).not.toBeNull();
    expect(row.confirm_token_hash).toBeNull();
    const hid = await site.db
      .selectFrom("request_works")
      .select("work_id")
      .where("request_id", "=", secondRequest)
      .execute();
    expect(hid).toHaveLength(0);
    // It waits in the queue for a moderator, confirmed (no "(unconfirmed)" mark).
    await page.goto(`${SITE}/admin/requests`);
    const queued = page.locator("tr", { hasText: "(42341)" });
    await expect.poll(() => queued.count()).toBe(1);
    expect(await queued.innerText()).not.toContain("(unconfirmed)");
    await expectLogged(site, {
      action: "block",
      targetKind: "request",
      targetId: firstRequest,
      moderatorId: mod.userId,
    });
  });

  it("A banned uploader's pending upload ends and a new one is refused", async () => {
    const { site } = running;
    const mod = await signedIn(site, { email: requesterEmail("mod-ban"), role: "moderator" });
    const page = await mod.context.newPage();
    const uploader = await signedIn(site, {
      email: requesterEmail("uploader-ban"),
      role: "uploader",
    });
    await seedReadableWork(site, {
      ao3WorkId: 42350,
      title: "Synthetic Work 42350",
      userId: uploader.userId,
    });
    const { id: pending } = await insertUpload(site.db, {
      userId: uploader.userId,
      r2Key: `uploads/pw6-${crypto.randomUUID()}`,
      bytes: 1234,
    });
    const uploadsOf = async () =>
      site.db.selectFrom("uploads").select("id").where("user_id", "=", uploader.userId).execute();
    const before = (await uploadsOf()).length;

    await page.goto(`${SITE}/admin/works/42350`);
    await page.getByRole("button", { name: "Ban uploader" }).click();
    await expect.poll(() => page.locator("main").innerText()).toContain("The uploader is banned.");

    // The uploader's own view, unrecorded: the pending upload ended, and the form is closed.
    const own = await uploader.context.newPage();
    site.dropRecording(own);
    await own.goto(`${SITE}/me/uploads`);
    const row = own.locator(`li[data-upload-id="${pending}"]`);
    await expect.poll(() => row.locator(".badge").innerText()).toContain("account can't upload");
    const closed = await own.goto(`${SITE}/upload`);
    expect(closed?.status()).toBe(403);
    await expect
      .poll(() => own.locator("main").innerText())
      .toContain("This account can't upload.");
    // A new upload, asked for as the page's script does, is refused and writes no row.
    await own.goto(`${SITE}/me/uploads`);
    const attempt = await own.evaluate(async (turnstile) => {
      const body = new URLSearchParams({ size: "1234", "cf-turnstile-response": turnstile });
      const res = await fetch("/uploads", { method: "POST", body });
      return { status: res.status, body: await res.json() };
    }, `${DUMMY_TOKEN}#upload`);
    expect(attempt).toEqual({ status: 403, body: { error: "This account can't upload." } });
    expect(await uploadsOf()).toHaveLength(before);
    const ended = await site.db
      .selectFrom("uploads")
      .select("status")
      .where("id", "=", pending)
      .executeTakeFirstOrThrow();
    expect(ended.status).toBe("account_banned");
    // The live work is still there for readers.
    expect((await site.fetch("/works/42350")).status).toBe(200);
    await expectLogged(site, {
      action: "ban",
      targetKind: "user",
      targetId: uploader.userId,
      moderatorId: mod.userId,
    });
    await site.assertClean({ allow: [/status of 403/] });
  });
});
