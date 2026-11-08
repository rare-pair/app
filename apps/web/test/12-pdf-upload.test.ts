import { createDb, insertUpload } from "@archive/db";
import { putFragments, seedVersion, seedWork } from "@archive/db/seed";
import { env } from "cloudflare:workers";
import { afterAll, describe, expect, it } from "vitest";
import { restoreOwnWorks } from "../src/admin-request-actions";
import { applyOptOut } from "../src/remove-confirm";
import { MESSAGES } from "../src/upload-badge";
import { BASE, fetchW, freshIp, signIn as signInAs, UPLOAD_TOKEN } from "./helpers";

// PDF upload on the web Worker (spec 12). This file keeps to AO3 work IDs 8813760 to 8813799.
// Text is synthetic.

const db = createDb({ connectionString: env.HYPERDRIVE.connectionString, max: 1 });
afterAll(() => db.destroy());

const PDF = "application/pdf";
const MB10 = 10 * 1024 * 1024;
const NOTICE = "Chapters may be imperfect; a moderator will check.";
const SAME_ORIGIN = { origin: BASE, "sec-fetch-site": "same-origin" };

async function signIn(role?: "moderator"): Promise<{ userId: string; cookie: string }> {
  const email = `pdf-${crypto.randomUUID().slice(0, 8)}@example.test`;
  const cookie = await signInAs(email, { next: "/upload", acceptTerms: true });
  const user = await db
    .selectFrom("user")
    .select("id")
    .where("email", "=", email)
    .executeTakeFirstOrThrow();
  if (role) await db.updateTable("user").set({ role }).where("id", "=", user.id).execute();
  return { userId: user.id, cookie };
}

const ask = (cookie: string, sizes: string[], types: string[]) => {
  const body = new URLSearchParams();
  for (const size of sizes) body.append("size", size);
  for (const type of types) body.append("type", type);
  body.set("cf-turnstile-response", UPLOAD_TOKEN);
  return fetchW("/uploads", {
    method: "POST",
    headers: {
      cookie,
      "cf-connecting-ip": freshIp(),
      "content-type": "application/x-www-form-urlencoded",
      ...SAME_ORIGIN,
    },
    body: body.toString(),
  });
};

async function opened(userId: string, bytes: number) {
  const id = crypto.randomUUID();
  const key = `uploads/${id}`;
  await insertUpload(db, { id, userId, r2Key: key, bytes });
  return { id, key };
}

const put = (id: string, cookie: string, body: Uint8Array, type: string) =>
  fetchW(`/uploads/${id}`, {
    method: "PUT",
    headers: { cookie, "content-type": type, ...SAME_ORIGIN },
    body,
  });

const get = async (path: string, cookie?: string) => {
  const res = await fetchW(path, cookie === undefined ? {} : { headers: { cookie } });
  return { status: res.status, html: await res.text() };
};

/** A same-origin form post, as the admin pages' forms send it. */
const post = async (path: string, fields: Record<string, string>, cookie: string) => {
  const res = await fetchW(path, {
    method: "POST",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded", ...SAME_ORIGIN },
    body: new URLSearchParams(fields).toString(),
  });
  return { status: res.status, html: await res.text() };
};

describe("12-pdf-upload", () => {
  describe("The upload page takes PDFs", () => {
    it("the page's wording says PDFs are accepted, and that an epub reads better", async () => {
      const { cookie } = await signIn();
      const { html } = await get("/upload", cookie);
      expect(html).toContain(".pdf");
      expect(html).toMatch(/PDFs?, 10 MB at most/);
      expect(html).toMatch(/an epub reads better/i);
    });

    it("PUT accepts application/pdf", async () => {
      const { userId, cookie } = await signIn();
      const { id, key } = await opened(userId, 8);
      const res = await put(id, cookie, new TextEncoder().encode("%PDF-1.7"), PDF);
      expect(res.status).toBe(200);
      const stored = await env.BUCKET.get(key);
      expect(stored?.httpMetadata?.contentType).toBe(PDF);
      await stored?.body.cancel();
    });

    it("PUT takes a PDF of exactly 10 MB", async () => {
      const { userId, cookie } = await signIn();
      const { id } = await opened(userId, MB10);
      expect((await put(id, cookie, new Uint8Array(MB10), PDF)).status).toBe(200);
    });

    it("PUT still refuses any other type with a 415", async () => {
      const { userId, cookie } = await signIn();
      const { id } = await opened(userId, 8);
      const res = await put(id, cookie, new Uint8Array(8), "application/octet-stream");
      expect(res.status).toBe(415);
    });
  });

  describe("A PDF over 10 MB", () => {
    it("is refused at POST /uploads on its declared size, in plain words", async () => {
      const { cookie } = await signIn();
      const res = await ask(cookie, [String(MB10 + 1)], [PDF]);
      expect(res.status).toBe(413);
      // SAFETY: a refused request answers JSON.
      expect(((await res.json()) as { error: string }).error).toMatch(/10 MB limit for a PDF/);
    });

    it("is taken at exactly 10 MB, and an epub still has its 25 MB", async () => {
      const { cookie } = await signIn();
      expect((await ask(cookie, [String(MB10)], [PDF])).status).toBe(200);
      expect((await ask(cookie, [String(MB10 + 1)], ["application/epub+zip"])).status).toBe(200);
      expect((await ask(cookie, [String(MB10 + 1)], [])).status).toBe(200);
    });

    it("goes by each file's own type in a batch", async () => {
      const { cookie } = await signIn();
      const res = await ask(cookie, ["10", String(MB10 + 1)], ["application/epub+zip", PDF]);
      expect(res.status).toBe(413);
    });

    it("is refused for a type POST /uploads doesn't know", async () => {
      const { cookie } = await signIn();
      expect((await ask(cookie, ["10"], ["text/html"])).status).toBe(415);
    });

    it("is refused at PUT by its content type, whatever was declared", async () => {
      const { userId, cookie } = await signIn();
      const { id } = await opened(userId, MB10 + 1);
      const res = await put(id, cookie, new Uint8Array(MB10 + 1), PDF);
      expect(res.status).toBe(413);
      // SAFETY: a refused request answers JSON.
      expect(((await res.json()) as { error: string }).error).toMatch(/10 MB limit for a PDF/);
    });

    it("gets a plain message on My uploads when ingest finds it by its bytes", () => {
      expect(MESSAGES.too_large).toMatch(/PDFs up to 10 MB/);
    });
  });

  describe("A file's bytes decide what it is", () => {
    it("not_epub's message says it isn't a valid EPUB or PDF", () => {
      expect(MESSAGES.not_epub).toMatch(/valid EPUB or PDF/);
    });
  });

  describe("The chapter count must match", () => {
    it("pdf_unreadable's message says the chapters couldn't be told apart and an epub would work", () => {
      expect(MESSAGES.pdf_unreadable).toMatch(/chapters couldn.t be told apart/i);
      expect(MESSAGES.pdf_unreadable).toMatch(/EPUB/);
    });
  });

  describe("A reader is told it was converted", () => {
    const seed = async (ao3WorkId: number, format: "epub" | "pdf", reviewReasons: string[]) => {
      const work = await seedWork(db, {
        ao3WorkId,
        format,
        reviewReasons,
        chapters: [{ html: "<p>Synthetic.</p>" }],
      });
      await putFragments(env.BUCKET, work.fragments);
      return work;
    };

    it("the work page and a chapter show the notice, and the work page says it's converted", async () => {
      await seed(8813760, "pdf", ["from_pdf"]);
      const work = await get("/works/8813760");
      expect(work.html).toContain(NOTICE);
      expect(work.html).toContain("Converted from a PDF");
      expect((await get("/works/8813760/chapters/1")).html).toContain(NOTICE);
    });

    it("it still says converted after a moderator's check", async () => {
      const seeded = await seed(8813761, "pdf", ["from_pdf"]);
      await db
        .updateTable("work_versions")
        .set({ checked_at: new Date() })
        .where("id", "=", seeded.versionId)
        .execute();
      const { html } = await get("/works/8813761");
      expect(html).not.toContain(NOTICE);
      expect(html).toContain("Converted from a PDF");
    });

    it("an epub's page says neither", async () => {
      await seed(8813762, "epub", []);
      const { html } = await get("/works/8813762");
      expect(html).not.toContain("Converted from a PDF");
      expect(html).not.toContain(NOTICE);
    });

    it("The original stays a download: the link says PDF and names the .pdf key", async () => {
      const seeded = await seed(8813763, "pdf", ["from_pdf"]);
      const { html } = await get("/works/8813763");
      expect(html).toContain(
        `<a href="https://content.rarepair.fans/originals/${seeded.uploadId}.pdf">Download original PDF</a>`,
      );
    });

    it("The original stays a download: an epub's link is as it was", async () => {
      const seeded = await seed(8813764, "epub", []);
      const { html } = await get("/works/8813764");
      expect(html).toContain(
        `<a href="https://content.rarepair.fans/originals/${seeded.uploadId}.epub">Download original epub</a>`,
      );
    });
  });

  describe("A moderator can check it", () => {
    it("Works to check says it in words, not reason codes", async () => {
      const work = await seedWork(db, {
        ao3WorkId: 8813770,
        title: "pdfcheck-8813770",
        format: "pdf",
        reviewReasons: ["from_pdf", "tags_from_print"],
      });
      await putFragments(env.BUCKET, work.fragments);
      const { cookie } = await signIn("moderator");
      const { html } = await get("/admin/works", cookie);
      expect(html).toContain("Converted from a PDF");
      expect(html).toContain("Tags read from print");
      expect(html).not.toContain("from_pdf");
      expect(html).not.toContain("tags_from_print");
    });

    it("A longer PDF held for a moderator says why, and can be made current", async () => {
      const work = await seedWork(db, { ao3WorkId: 8813771, title: "pdfcheck-8813771" });
      await putFragments(env.BUCKET, work.fragments);
      const held = await seedVersion(db, work, {
        current: false,
        format: "pdf",
        holdReason: "pdf_more_chapters",
        reviewReasons: ["from_pdf", "tags_from_print"],
        chapters: 2,
      });
      await putFragments(env.BUCKET, held.fragments);
      const { cookie } = await signIn("moderator");

      const queue = await get("/admin/works", cookie);
      expect(queue.html).toContain("A PDF with more chapters than the current epub");

      const page = await get("/admin/works/8813771", cookie);
      expect(page.html).toContain("A PDF with more chapters than the current epub");
      expect(page.html).toContain("Converted from a PDF");
      expect(page.html).toContain("Tags read from print");
      expect(page.html).toContain("Make current");
    });

    it("A first PDF held for its byline is listed, and approving it puts the work live", async () => {
      const work = await seedWork(db, {
        ao3WorkId: 8813772,
        title: "pdfcheck-8813772",
        format: "pdf",
        heldFirst: "pdf_byline_unsure",
        reviewReasons: ["from_pdf", "byline_unsure"],
      });
      await putFragments(env.BUCKET, work.fragments);
      const { cookie } = await signIn("moderator");
      expect((await get("/works/8813772")).status).toBe(404);

      const queue = await get("/admin/works", cookie);
      expect(queue.html).toContain("A PDF whose byline may not have been read whole");
      const page = await get("/admin/works/8813772", cookie);
      expect(page.html).toContain("held: not live until a version is approved");
      expect(page.html).toContain("Byline may not have been read whole");
      expect(page.html).not.toContain("pdf_byline_unsure");

      const approved = await post(
        "/admin/works/8813772/approve",
        { version: work.versionId },
        cookie,
      );
      expect(approved.html).toContain("That version is approved and now current.");
      expect((await get("/works/8813772")).status).toBe(200);
    });

    it("A held PDF shows every reason it is held for, the byline's first", async () => {
      const work = await seedWork(db, { ao3WorkId: 8813773, title: "pdfcheck-8813773" });
      await putFragments(env.BUCKET, work.fragments);
      const held = await seedVersion(db, work, {
        current: false,
        format: "pdf",
        holdReason: "pdf_byline_unsure",
        chapters: 2,
      });
      await db
        .updateTable("work_versions")
        .set({ other_hold_reasons: ["pdf_more_chapters"] })
        .where("id", "=", held.versionId)
        .execute();
      const { cookie } = await signIn("moderator");
      const both =
        "A PDF whose byline may not have been read whole: check its authors, A PDF with more chapters than the current epub";
      expect((await get("/admin/works", cookie)).html).toContain(`Held version: ${both}`);
      expect((await get("/admin/works/8813773", cookie)).html).toContain(
        `Held for review: ${both}`,
      );
    });

    it("An opt-out hides a held first upload, by its login or by any version it holds", async () => {
      const byLogin = await seedWork(db, {
        ao3WorkId: 8813774,
        format: "pdf",
        heldFirst: "pdf_byline_unsure",
        authors: [{ pseud: "Shown Pseud", ao3_user: "optlogin8813774" }],
      });
      const byLater = await seedWork(db, {
        ao3WorkId: 8813775,
        format: "pdf",
        heldFirst: "pdf_byline_unsure",
      });
      await seedVersion(db, byLater, {
        current: false,
        format: "pdf",
        holdReason: "pdf_byline_unsure",
        authors: [{ pseud: "Later Pseud 8813775", ao3_user: null }],
      });
      for (const pseud of ["optlogin8813774", "later pseud 8813775"]) {
        await db.transaction().execute(async (trx) => {
          const request = await trx
            .insertInto("requests")
            .values({
              kind: "opt_out",
              pseud_norm: pseud,
              contact_email: "requester@example.test",
              statement: "A short statement.",
              ip_hash: "hash-of-an-ip",
            })
            .returning("id")
            .executeTakeFirstOrThrow();
          await applyOptOut(trx, { id: request.id, pseud_norm: pseud });
        });
      }
      const works = await db
        .selectFrom("works")
        .select(["status", "hidden_cause"])
        .where("id", "in", [byLogin.workId, byLater.workId])
        .execute();
      expect(works).toEqual([
        { status: "hidden", hidden_cause: "removal_request" },
        { status: "hidden", hidden_cause: "removal_request" },
      ]);
    });

    it("Reversing one opt-out leaves a work hidden while another covers it by login", async () => {
      const work = await seedWork(db, {
        ao3WorkId: 8813778,
        format: "pdf",
        heldFirst: "pdf_byline_unsure",
        authors: [{ pseud: "Shown 8813778", ao3_user: "login8813778" }],
      });
      const optOut = (pseud: string) =>
        db.transaction().execute(async (trx) => {
          const request = await trx
            .insertInto("requests")
            .values({
              kind: "opt_out",
              pseud_norm: pseud,
              contact_email: "requester@example.test",
              statement: "A short statement.",
              ip_hash: "hash-of-an-ip",
            })
            .returning("id")
            .executeTakeFirstOrThrow();
          await applyOptOut(trx, { id: request.id, pseud_norm: pseud });
          return request.id;
        });
      await optOut("login8813778");
      const byPseud = await optOut("shown 8813778");

      const { restored } = await db.transaction().execute((trx) =>
        restoreOwnWorks(
          trx,
          byPseud,
          [
            {
              id: work.workId,
              ao3WorkId: 8813778,
              status: "hidden",
              hiddenCause: "removal_request",
            },
          ],
          new Set(),
        ),
      );

      expect(restored).toEqual([]);
    });

    it("Approving a held version whose author has opted out keeps it held, and says so", async () => {
      const work = await seedWork(db, {
        ao3WorkId: 8813776,
        format: "pdf",
        heldFirst: "pdf_byline_unsure",
        authors: [{ pseud: "Opted 8813776", ao3_user: null }],
      });
      const request = await db
        .insertInto("requests")
        .values({
          kind: "opt_out",
          pseud_norm: "opted 8813776",
          contact_email: "requester@example.test",
          statement: "A short statement.",
          ip_hash: "hash-of-an-ip",
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      await db
        .insertInto("optouts")
        .values({ pseud_norm: "opted 8813776", request_id: request.id, active: true })
        .execute();
      const { cookie } = await signIn("moderator");

      const approved = await post(
        "/admin/works/8813776/approve",
        { version: work.versionId },
        cookie,
      );

      expect(approved.html).toContain("an author of that version is on the opt-out list");
      expect((await get("/works/8813776")).status).toBe(404);
    });

    it("A held first upload can be removed", async () => {
      const work = await seedWork(db, {
        ao3WorkId: 8813777,
        format: "pdf",
        heldFirst: "pdf_byline_unsure",
      });
      const { cookie } = await signIn("moderator");

      await post("/admin/works/8813777/remove", { confirm: "yes" }, cookie);

      const row = await db
        .selectFrom("works")
        .select("status")
        .where("id", "=", work.workId)
        .executeTakeFirstOrThrow();
      expect(row.status).toBe("removed");
    });
  });
});
