import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getLiveWork, originalKey, originalKeys } from "../src/index";
import { seedWork } from "../src/seed";
import { createTestDb, type TestDb } from "../src/testing";

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  // oxlint-disable-next-line typescript/no-unnecessary-condition -- unset if beforeAll failed
  await t?.close();
});

async function upload(values: { format?: "epub" | "pdf"; status?: "pdf_unreadable" }) {
  const id = crypto.randomUUID();
  await t.db
    .insertInto("user")
    .values({ id, name: "Uploader", email: `${id}@example.test`, email_verified: true })
    .execute();
  return t.db
    .insertInto("uploads")
    .values({ user_id: id, r2_key: `uploads/${id}.epub`, bytes: 1, ...values })
    .returning(["format", "status"])
    .executeTakeFirstOrThrow();
}

describe("12-pdf-upload", () => {
  describe("Setup", () => {
    it("An upload's format defaults to epub and may be pdf", async () => {
      expect((await upload({})).format).toBe("epub");
      expect((await upload({ format: "pdf" })).format).toBe("pdf");
    });

    it("An upload's format is nothing else", async () => {
      // SAFETY: the check under test refuses what the type does.
      await expect(upload({ format: "docx" as "pdf" })).rejects.toThrow();
    });

    it("pdf_unreadable is an upload status", async () => {
      expect((await upload({ status: "pdf_unreadable" })).status).toBe("pdf_unreadable");
    });

    it("Every reader of an original builds its key through one helper", () => {
      expect(originalKey("up-1", "epub")).toBe("originals/up-1.epub");
      expect(originalKey("up-1", "pdf")).toBe("originals/up-1.pdf");
      expect(originalKeys("up-1")).toEqual(["originals/up-1.epub", "originals/up-1.pdf"]);
    });

    it("A held PDF's reason is a hold reason", async () => {
      const { versionId } = await seedWork(t.db, { ao3WorkId: 8813700 });
      const row = await t.db
        .updateTable("work_versions")
        .set({ hold_reason: "pdf_more_chapters" })
        .where("id", "=", versionId)
        .returning("hold_reason")
        .executeTakeFirstOrThrow();
      expect(row.hold_reason).toBe("pdf_more_chapters");
    });
  });

  describe("A reader is told it was converted", () => {
    it("the current version's format comes from its upload", async () => {
      await seedWork(t.db, { ao3WorkId: 8813701 });
      await seedWork(t.db, { ao3WorkId: 8813702, format: "pdf" });
      expect((await getLiveWork(t.db, 8813701))?.version.original_format).toBe("epub");
      expect((await getLiveWork(t.db, 8813702))?.version.original_format).toBe("pdf");
    });
  });
});
