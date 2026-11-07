import { createDb, insertUpload } from "@archive/db";
import { putFragments, seedVersion, seedWork } from "@archive/db/seed";
import { env } from "cloudflare:workers";
import { afterAll, describe, expect, it } from "vitest";
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
  });
});
