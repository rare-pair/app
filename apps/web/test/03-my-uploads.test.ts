import { createDb, insertUpload, type UploadStatus } from "@archive/db";
import { seedWork } from "@archive/db/seed";
import { env } from "cloudflare:workers";
import { afterAll, describe, expect, it } from "vitest";
import { fetchW, nonceOf, signIn as signInAs } from "./helpers";

// U6b-1's cases: `GET /me/uploads`, the signed-in user's own uploads. One database
// serves every test file of a project, so each test signs in its own user and this
// file keeps to work IDs 16100 to 16199.
const db = createDb({ connectionString: env.HYPERDRIVE.connectionString, max: 1 });
afterAll(() => db.destroy());

let counter = 0;
/** Signs a new user in and returns their id and session cookie. */
async function signIn({ acceptTerms = true } = {}): Promise<{ userId: string; cookie: string }> {
  const email = `u6b1-${Date.now()}-${counter++}@example.test`;
  const cookie = await signInAs(email, { next: "/upload", acceptTerms });
  const user = await db
    .selectFrom("user")
    .select("id")
    .where("email", "=", email)
    .executeTakeFirstOrThrow();
  return { userId: user.id, cookie };
}

/** An upload by `userId` in `status`; `confirmed` sets the time its quota was counted. */
async function upload(
  userId: string,
  status: UploadStatus,
  { workId = null, confirmed = true }: { workId?: string | null; confirmed?: boolean } = {},
) {
  const { id } = await insertUpload(db, {
    userId,
    r2Key: `uploads/${crypto.randomUUID()}`,
    bytes: 1234,
  });
  await db
    .updateTable("uploads")
    .set({
      status,
      work_id: workId,
      quota_counted_at: confirmed ? new Date() : null,
      sha256: "a".repeat(64),
      error_stage: "stage-marker",
      error: "error-marker",
    })
    .where("id", "=", id)
    .execute();
  return id;
}

const page = (cookie?: string) =>
  fetchW("/me/uploads", { headers: cookie === undefined ? {} : { cookie } });

/** The text of the badge in the list item for upload `id`. */
function badgeOf(html: string, id: string): string | undefined {
  const item = html.match(new RegExp(`<li[^>]*data-upload-id="${id}"[^>]*>[\\s\\S]*?</li>`))?.[0];
  return item?.match(/<span class="badge"[^>]*>([^<]*)<\/span>/)?.[1];
}

const REFRESH = '<meta http-equiv="refresh" content="5">';

describe("03-upload-status: My uploads", () => {
  it("My uploads lists every upload with a text status badge", async () => {
    const { userId, cookie } = await signIn();
    const work = await seedWork(db, { ao3WorkId: 16100, title: "u6b1-listed" });
    const ids = {
      processing: await upload(userId, "processing"),
      live: await upload(userId, "live", { workId: work.workId }),
      held: await upload(userId, "held_for_review"),
      duplicate: await upload(userId, "duplicate", { workId: work.workId }),
      rejected: await upload(userId, "not_ao3"),
      waiting: await upload(userId, "pending", { confirmed: false }),
      confirmed: await upload(userId, "pending"),
    };

    const html = await (await page(cookie)).text();

    expect(badgeOf(html, ids.processing)).toBe("Processing");
    expect(badgeOf(html, ids.live)).toBe("Live");
    expect(badgeOf(html, ids.held)).toBe("Held for review");
    expect(badgeOf(html, ids.duplicate)).toBe("Already in the archive");
    expect(badgeOf(html, ids.rejected)).toBe("Rejected");
    expect(badgeOf(html, ids.waiting)).toBe("Not uploaded yet");
    expect(badgeOf(html, ids.confirmed)).toBe("Processing");
  });

  it("Every rejection code gets a Rejected badge", async () => {
    const { userId, cookie } = await signIn();
    const codes: UploadStatus[] = [
      "not_epub",
      "zip_bomb",
      "too_large",
      "not_ao3",
      "opted_out",
      "parse_failed",
      "over_quota",
    ];
    const ids = await Promise.all(codes.map((code) => upload(userId, code)));

    const html = await (await page(cookie)).text();

    for (const id of ids) expect(badgeOf(html, id)).toBe("Rejected");
  });

  it("A live upload row is named by its work's title, the others by date", async () => {
    const { userId, cookie } = await signIn();
    const work = await seedWork(db, { ao3WorkId: 16108, title: "u6b1-titled" });
    await upload(userId, "live", { workId: work.workId });
    const held = await upload(userId, "held_for_review");
    await db
      .updateTable("uploads")
      .set({ created_at: "2026-03-04T05:06:07Z" })
      .where("id", "=", held)
      .execute();

    const html = await (await page(cookie)).text();

    expect(html).toContain("u6b1-titled");
    expect(html).toContain("Upload of 2026-03-04 05:06 UTC");
  });

  it("The list is newest first and holds at most 50 uploads", async () => {
    const { userId, cookie } = await signIn();
    const ids: string[] = [];
    for (let i = 0; i < 52; i++) ids.push(await upload(userId, "held_for_review"));
    for (const [i, id] of ids.entries()) {
      await db
        .updateTable("uploads")
        .set({ created_at: new Date(Date.UTC(2026, 0, 1, 0, i)) })
        .where("id", "=", id)
        .execute();
    }

    const html = await (await page(cookie)).text();
    const listed = [...html.matchAll(/data-upload-id="([^"]+)"/g)].map((m) => m[1]);

    expect(listed).toEqual(ids.slice(2).reverse());
    expect(html).toContain("Showing your 50 most recent uploads.");
  });

  it("My uploads shows only the signed-in user's uploads", async () => {
    const u = await signIn();
    const v = await signIn();
    const mine = await upload(u.userId, "processing");
    const theirs = await upload(v.userId, "processing");
    const theirsHeld = await upload(v.userId, "held_for_review");

    const html = await (await page(u.cookie)).text();

    expect(html).toContain(mine);
    expect(html).not.toContain(theirs);
    expect(html).not.toContain(theirsHeld);
  });

  it("Live upload links to its work", async () => {
    const { userId, cookie } = await signIn();
    const live = await seedWork(db, { ao3WorkId: 16101, title: "u6b1-live" });
    const dup = await seedWork(db, { ao3WorkId: 16102, title: "u6b1-dup" });
    await upload(userId, "live", { workId: live.workId });
    await upload(userId, "duplicate", { workId: dup.workId });

    const html = await (await page(cookie)).text();

    expect(html).toContain('<a href="/works/16101">');
    expect(html).toContain('<a href="/works/16102">');
  });

  it("A live upload of a work that is now hidden or removed shows no link", async () => {
    const { userId, cookie } = await signIn();
    const hidden = await seedWork(db, {
      ao3WorkId: 16103,
      title: "u6b1-hidden",
      status: "hidden",
      hiddenCause: "moderator",
    });
    const removed = await seedWork(db, {
      ao3WorkId: 16104,
      title: "u6b1-removed",
      status: "removed",
    });
    await upload(userId, "live", { workId: hidden.workId });
    await upload(userId, "live", { workId: removed.workId });

    const html = await (await page(cookie)).text();

    expect(html).not.toContain("/works/16103");
    expect(html).not.toContain("/works/16104");
    expect(html).not.toContain("u6b1-hidden");
    expect(html).not.toContain("u6b1-removed");
  });

  it("My uploads refreshes itself while something is processing (no JS)", async () => {
    const { userId, cookie } = await signIn();
    await upload(userId, "live", {
      workId: (await seedWork(db, { ao3WorkId: 16105, title: "u6b1-r" })).workId,
    });
    await upload(userId, "processing");

    const html = await (await page(cookie)).text();

    expect(html).toContain(REFRESH);
    expect(html.indexOf(REFRESH)).toBeLessThan(html.indexOf("</head>"));
  });

  it("A confirmed pending upload refreshes the page, an unconfirmed one doesn't", async () => {
    const confirmed = await signIn();
    await upload(confirmed.userId, "pending");
    const waiting = await signIn();
    await upload(waiting.userId, "pending", { confirmed: false });

    expect(await (await page(confirmed.cookie)).text()).toContain(REFRESH);
    expect(await (await page(waiting.cookie)).text()).not.toMatch(/http-equiv="refresh"/i);
  });

  it("My uploads stops refreshing when nothing is processing", async () => {
    const { userId, cookie } = await signIn();
    const work = await seedWork(db, { ao3WorkId: 16106, title: "u6b1-s" });
    await upload(userId, "live", { workId: work.workId });
    await upload(userId, "held_for_review");
    await upload(userId, "duplicate", { workId: work.workId });
    await upload(userId, "parse_failed");

    const html = await (await page(cookie)).text();

    expect(html).not.toMatch(/http-equiv="refresh"/i);
  });

  it("An empty list doesn't refresh", async () => {
    const { cookie } = await signIn();

    const res = await page(cookie);

    expect(res.status).toBe(200);
    expect(await res.text()).not.toMatch(/http-equiv="refresh"/i);
  });

  it("My uploads requires sign-in", async () => {
    const { userId } = await signIn();
    await upload(userId, "processing");

    const res = await page();

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/login?next=%2Fme%2Fuploads");
    expect(await res.text()).not.toContain("data-upload-id");
  });

  it("An account that hasn't accepted the terms is sent to them first", async () => {
    const { cookie } = await signIn({ acceptTerms: false });

    const res = await page(cookie);

    expect(res.status).toBe(302);
    expect(new URL(res.headers.get("location")!, "https://rarepair.fans").pathname).toBe(
      "/welcome/terms",
    );
  });

  it("The page is no-store, nonced, script-free and shows no internal field", async () => {
    const { userId, cookie } = await signIn();
    const work = await seedWork(db, { ao3WorkId: 16107, title: "u6b1-internal" });
    await upload(userId, "live", { workId: work.workId });
    await upload(userId, "parse_failed");

    const res = await page(cookie);
    const html = await res.text();

    expect(res.headers.get("cache-control")).toMatch(/no-store/);
    expect(nonceOf(res.headers.get("content-security-policy"))).not.toBeNull();
    expect(res.headers.get("content-security-policy")).not.toContain("frame-src");
    expect(html).not.toContain("<script");
    for (const leak of ["uploads/", "aaaaaaaa", "marker", "@example.test"]) {
      expect(html).not.toContain(leak);
    }
  });
});
