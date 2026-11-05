import { createDb, deleteUnconfirmedUploads, insertUpload, type UploadStatus } from "@archive/db";
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

/** The text of the message slot in the list item for upload `id`. */
function messageOf(html: string, id: string): string | undefined {
  const item = html.match(new RegExp(`<li[^>]*data-upload-id="${id}"[^>]*>[\\s\\S]*?</li>`))?.[0];
  return item
    ?.match(/<p class="upload-message">([^<]*)<\/p>/)?.[1]
    ?.replaceAll("&#39;", "'")
    .replaceAll("&amp;", "&");
}

const REFRESH = '<noscript><meta http-equiv="refresh" content="5"></noscript>';

describe("03-upload-status: My uploads", () => {
  it("An unconfirmed upload removed as stale no longer shows on My uploads", async () => {
    const { userId, cookie } = await signIn();
    const stale = await upload(userId, "pending", { confirmed: false });
    const kept = await upload(userId, "pending", { confirmed: false });
    // Dated far enough back that the cutoff below reaches no other test's row in this database.
    await db
      .updateTable("uploads")
      .set({ created_at: new Date("2000-01-01T00:00:00Z") })
      .where("id", "=", stale)
      .execute();
    expect(await (await page(cookie)).text()).toContain(`data-upload-id="${stale}"`);

    await deleteUnconfirmedUploads(db, new Date("2000-01-02T00:00:00Z"), 1000);

    const html = await (await page(cookie)).text();
    expect(html).not.toContain(`data-upload-id="${stale}"`);
    expect(html).toContain(`data-upload-id="${kept}"`);
  });

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
    expect(badgeOf(html, ids.rejected)).toBe("Rejected: not an AO3 export");
    expect(badgeOf(html, ids.waiting)).toBe("Not uploaded yet");
    expect(badgeOf(html, ids.confirmed)).toBe("Processing");
  });

  it("Every rejection code gets a Rejected badge", async () => {
    const { userId, cookie } = await signIn();
    const badges: Array<[UploadStatus, string]> = [
      ["not_epub", "Rejected: not an EPUB"],
      ["zip_bomb", "Rejected: file can't be opened safely"],
      ["too_large", "Rejected: too large"],
      ["not_ao3", "Rejected: not an AO3 export"],
      ["opted_out", "Rejected"],
      ["work_removed", "Rejected"],
      ["account_banned", "Rejected: account can't upload"],
      ["parse_failed", "Failed"],
    ];
    const ids: string[] = [];
    for (const [code] of badges) ids.push(await upload(userId, code));

    const html = await (await page(cookie)).text();

    expect(ids.map((id) => badgeOf(html, id))).toEqual(badges.map(([, badge]) => badge));
  });

  it("An upload over the daily quota is not called rejected", async () => {
    const { userId, cookie } = await signIn();
    const id = await upload(userId, "over_quota");

    expect(badgeOf(await (await page(cookie)).text(), id)).toBe("Daily limit reached");
  });

  it("A work title is escaped and an empty one falls back to the date", async () => {
    const { userId, cookie } = await signIn();
    const hostile = await seedWork(db, { ao3WorkId: 16109, title: `<b>"x"</b>` });
    const blank = await seedWork(db, { ao3WorkId: 16110, title: "  " });
    await upload(userId, "live", { workId: hostile.workId });
    const blankId = await upload(userId, "live", { workId: blank.workId });

    const html = await (await page(cookie)).text();

    expect(html).toContain("&lt;b&gt;");
    expect(html).not.toContain("<b>");
    expect(html).not.toContain(`<a href="/works/16110"></a>`);
    expect(html).toMatch(
      new RegExp(`data-upload-id="${blankId}"[^>]*><span class="upload-name">Upload of `),
    );
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

  it("Held upload is shown to its uploader", async () => {
    const u = await signIn();
    const v = await signIn();
    const live = await seedWork(db, { ao3WorkId: 61600, title: "smallfix-held-live" });
    const gone = await seedWork(db, {
      ao3WorkId: 61601,
      title: "smallfix-held-hidden",
      status: "hidden",
      hiddenCause: "moderator",
    });
    const mine = await upload(u.userId, "held_for_review", { workId: live.workId });
    const mineHidden = await upload(u.userId, "held_for_review", { workId: gone.workId });
    const theirs = await upload(v.userId, "held_for_review", { workId: live.workId });

    const html = await (await page(u.cookie)).text();
    const theirHtml = await (await page(v.cookie)).text();

    // The uploader sees the work's title as a plain name, with no link to the work.
    expect(html).toMatch(
      new RegExp(
        `data-upload-id="${mine}"[^>]*><span class="upload-name"><bdi>smallfix-held-live</bdi></span>`,
      ),
    );
    expect(badgeOf(html, mine)).toBe("Held for review");
    expect(html).not.toContain('<a href="/works/61600">');
    // A hidden work keeps the dated name: the uploader isn't told of such a work.
    expect(html).toMatch(
      new RegExp(`data-upload-id="${mineHidden}"[^>]*><span class="upload-name">Upload of `),
    );
    expect(html).not.toContain("smallfix-held-hidden");
    // Another user's page holds no row of this one's.
    expect(theirHtml).not.toContain(mine);
    expect(theirHtml).toContain(theirs);
  });

  it("The list is newest first and holds at most 50 uploads", async () => {
    const { userId, cookie } = await signIn();
    const ids: string[] = [];
    const add = async (count: number) => {
      for (let i = 0; i < count; i++) {
        const id = await upload(userId, "held_for_review");
        await db
          .updateTable("uploads")
          .set({ created_at: new Date(Date.UTC(2026, 0, 1, 0, ids.length)) })
          .where("id", "=", id)
          .execute();
        ids.push(id);
      }
    };
    await add(50);
    // Exactly 50: all of them shown, and nothing was cut.
    expect(await (await page(cookie)).text()).not.toContain("Showing your");
    await add(2);

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

  it("My uploads refreshes itself while something is processing (no JS: the meta refresh is in noscript)", async () => {
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

  it("The page is no-store, has no script when nothing is in progress, and shows no internal field", async () => {
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

  const SCRIPT_TAG =
    /<script src="(\/assets\/my-uploads\.[0-9a-f]+\.js)" nonce="([^"]+)" defer><\/script>/;

  it("My uploads updates in place with JS: a processing upload brings the nonced script", async () => {
    const { userId, cookie } = await signIn();
    await upload(userId, "processing");

    const res = await page(cookie);
    const html = await res.text();

    const [, src, nonce] = SCRIPT_TAG.exec(html) ?? [];
    expect(src).toBeDefined();
    expect(nonce).toBe(nonceOf(res.headers.get("content-security-policy")));
    expect(html.indexOf(src!)).toBeLessThan(html.indexOf("</head>"));
    expect(html.match(/<script/g)).toHaveLength(1);
    expect(res.headers.get("content-security-policy")).not.toContain("frame-src");
    expect(html).toContain('<ul class="upload-list" aria-live="polite">');
  });

  it("The script file is immutable, nosniff, cookie-free, and carries no internal field", async () => {
    const { userId, cookie } = await signIn();
    await upload(userId, "processing");
    const src = SCRIPT_TAG.exec(await (await page(cookie)).text())?.[1];

    const res = await fetchW(src ?? "/missing.js");
    const text = await res.text();

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.getSetCookie()).toEqual([]);
    for (const leak of ["innerHTML", "error_stage", "sha256", "r2_key", "@"]) {
      expect(text).not.toContain(leak);
    }
  });

  it("Only in-progress rows are marked for polling", async () => {
    const { userId, cookie } = await signIn();
    const work = await seedWork(db, { ao3WorkId: 16120, title: "u6b2-live" });
    const waiting = await upload(userId, "pending");
    const processing = await upload(userId, "processing");
    const unconfirmed = await upload(userId, "pending", { confirmed: false });
    const live = await upload(userId, "live", { workId: work.workId });

    const html = await (await page(cookie)).text();
    const polling = (id: string) =>
      new RegExp(`<li data-upload-id="${id}"[^>]* data-polling[ >]`).test(html);

    expect(polling(waiting)).toBe(true);
    expect(polling(processing)).toBe(true);
    expect(polling(unconfirmed)).toBe(false);
    expect(polling(live)).toBe(false);
    expect(html).toContain('<span class="upload-name">');
  });

  // Draft copy: the operator proofs the wording, so these check what a message says and
  // asks of the uploader, not its exact words.
  const rejected: Array<[UploadStatus, RegExp]> = [
    ["not_ao3", /isn't an AO3 download.*Download the work from AO3 as an EPUB/],
    ["not_epub", /isn't a valid EPUB.*try again/i],
    ["zip_bomb", /won't open.*try again/i],
    ["too_large", /too large.*25 MB/],
    ["opted_out", /^This work can't be added to the archive\.$/],
  ];
  for (const [code, phrase] of rejected) {
    it(`Rejected ${code} upload shows a plain-language message`, async () => {
      const { userId, cookie } = await signIn();
      const id = await upload(userId, code);

      const html = await (await page(cookie)).text();

      expect(messageOf(html, id)).toMatch(phrase);
    });
  }

  it("Rejected opted_out upload names neither an opt-out nor a takedown, and links nothing", async () => {
    const { userId, cookie } = await signIn();
    const id = await upload(userId, "opted_out");

    const html = await (await page(cookie)).text();

    expect(messageOf(html, id)).not.toMatch(/opt|takedown|taken down|\/remove|\/dmca/i);
    expect(html).not.toContain("/works/");
  });

  it("Duplicate upload says the work is already in the archive", async () => {
    const { userId, cookie } = await signIn();
    const work = await seedWork(db, { ao3WorkId: 16130, title: "u6c-dup" });
    const id = await upload(userId, "duplicate", { workId: work.workId });

    const html = await (await page(cookie)).text();

    // Exactly this text, so it isn't "Rejected": a duplicate is a status, not a rejection.
    expect(badgeOf(html, id)).toBe("Already in the archive");
    expect(html).toContain('<a href="/works/16130">');
    expect(messageOf(html, id)).toMatch(/already in the archive/);
  });

  it("A live or duplicate upload of a work no longer open says nothing of the archive", async () => {
    const { userId, cookie } = await signIn();
    const hidden = await seedWork(db, {
      ao3WorkId: 16131,
      title: "u6c-hidden",
      status: "hidden",
      hiddenCause: "moderator",
    });
    const live = await upload(userId, "live", { workId: hidden.workId });
    const dup = await upload(userId, "duplicate", { workId: hidden.workId });

    const html = await (await page(cookie)).text();

    for (const id of [live, dup]) {
      const message = messageOf(html, id) ?? "";
      expect(message).not.toBe("");
      expect(message).not.toMatch(/archive/i);
    }
    expect(html).not.toContain("/works/16131");
  });

  it("Held upload is shown to its uploader", async () => {
    const u = await signIn();
    const v = await signIn();
    const id = await upload(u.userId, "held_for_review");

    const html = await (await page(u.cookie)).text();

    expect(badgeOf(html, id)).toBe("Held for review");
    expect(messageOf(html, id)).toMatch(/moderator will check/);
    expect(await (await page(v.cookie)).text()).not.toContain(id);
  });

  it("Failed upload shows a plain-language message", async () => {
    const { userId, cookie } = await signIn();
    const id = await upload(userId, "parse_failed");

    const html = await (await page(cookie)).text();

    expect(messageOf(html, id)).toMatch(/couldn't process this file.*try uploading it again/i);
    expect(html).not.toContain("marker");
  });

  it("The other statuses each get a message", async () => {
    const { userId, cookie } = await signIn();
    const work = await seedWork(db, { ao3WorkId: 16132, title: "u6c-other" });
    const waiting = await upload(userId, "pending", { confirmed: false });
    const confirmed = await upload(userId, "pending");
    const processing = await upload(userId, "processing");
    const live = await upload(userId, "live", { workId: work.workId });
    const quota = await upload(userId, "over_quota");
    const removed = await upload(userId, "work_removed");
    const banned = await upload(userId, "account_banned");

    const html = await (await page(cookie)).text();

    expect(messageOf(html, waiting)).toMatch(/hasn't finished uploading/);
    expect(messageOf(html, confirmed)).toMatch(/reading this file/);
    expect(messageOf(html, processing)).toMatch(/reading this file/);
    expect(messageOf(html, live)).toBe("This work is in the archive.");
    expect(messageOf(html, quota)).toMatch(/^(?!.*(UTC|\d\d:\d\d)).*daily limit/);
    expect(messageOf(html, removed)).toBe("This work was removed from the archive.");
    expect(messageOf(html, banned)).toBe("This account can no longer upload.");
  });

  it("Messages never imply AO3 approval", async () => {
    const { userId, cookie } = await signIn();
    const work = await seedWork(db, { ao3WorkId: 16133, title: "u6c-approval" });
    const statuses: UploadStatus[] = [
      "pending",
      "processing",
      "live",
      "held_for_review",
      "duplicate",
      "not_epub",
      "zip_bomb",
      "too_large",
      "not_ao3",
      "opted_out",
      "parse_failed",
      "over_quota",
      "work_removed",
      "account_banned",
    ];
    const ids: string[] = [];
    for (const status of statuses) {
      ids.push(await upload(userId, status, { workId: status === "live" ? work.workId : null }));
    }

    const html = await (await page(cookie)).text();

    for (const id of ids) {
      const text = `${badgeOf(html, id)} ${messageOf(html, id)}`;
      expect(messageOf(html, id)).toBeTruthy();
      expect(text).not.toMatch(/approv|verif|official|endors|affiliat|partner|authoriz/i);
      expect(text.replace(/an AO3 (download|export)|from AO3/g, "")).not.toMatch(/AO3/);
    }
  });

  it("An unconfirmed pending upload brings neither the script nor the refresh", async () => {
    const { userId, cookie } = await signIn();
    await upload(userId, "pending", { confirmed: false });

    const html = await (await page(cookie)).text();

    expect(html).not.toContain("<script");
    expect(html).not.toMatch(/http-equiv="refresh"/i);
  });
});
