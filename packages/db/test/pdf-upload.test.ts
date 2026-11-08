import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  approveVersion,
  getLiveWork,
  getWorkAvailability,
  hideWork,
  makeVersionCurrent,
  originalKey,
  originalKeys,
  recordUploadHash,
  removeWork,
  restoreWork,
} from "../src/index";
import { seedVersion, seedWork } from "../src/seed";
import { createTestDb, type TestDb } from "../src/testing";

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  // oxlint-disable-next-line typescript/no-unnecessary-condition -- unset if beforeAll failed
  await t?.close();
});

async function addModerator() {
  const id = `pdf-mod-${crypto.randomUUID()}`;
  await t.db
    .insertInto("user")
    .values({ id, name: id, email: `${id}@example.test`, email_verified: true, role: "moderator" })
    .execute();
  return id;
}

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

  describe("A byline the reader isn't sure of is held", () => {
    it("pdf_byline_unsure is a hold reason", async () => {
      const { versionId } = await seedWork(t.db, { ao3WorkId: 8813703 });
      const row = await t.db
        .updateTable("work_versions")
        .set({ hold_reason: "pdf_byline_unsure" })
        .where("id", "=", versionId)
        .returning("hold_reason")
        .executeTakeFirstOrThrow();
      expect(row.hold_reason).toBe("pdf_byline_unsure");
    });

    it("a held first upload leaves its work unlisted until a moderator approves it", async () => {
      const seeded = await seedWork(t.db, {
        ao3WorkId: 8813704,
        format: "pdf",
        heldFirst: "pdf_byline_unsure",
      });
      expect(await getLiveWork(t.db, 8813704)).toBeNull();
      // Only an approval publishes it: "Make current" doesn't.
      expect(await makeVersionCurrent(t.db, seeded.workId, seeded.versionId)).toBe(false);
      expect(await approveVersion(t.db, seeded.workId, seeded.versionId)).toBe("published");
      const work = await t.db
        .selectFrom("works")
        .select(["status", "current_version_id"])
        .where("id", "=", seeded.workId)
        .executeTakeFirstOrThrow();
      expect(work).toEqual({ status: "live", current_version_id: seeded.versionId });
      expect((await getLiveWork(t.db, 8813704))?.version.id).toBe(seeded.versionId);
      const upload = await t.db
        .selectFrom("uploads")
        .select("status")
        .where("id", "=", seeded.uploadId)
        .executeTakeFirstOrThrow();
      expect(upload.status).toBe("live");
    });

    it("a held first upload's work is held: its byline is the work's, and nothing serves it", async () => {
      const seeded = await seedWork(t.db, {
        ao3WorkId: 8813705,
        format: "pdf",
        heldFirst: "pdf_byline_unsure",
        authors: [{ pseud: "Held Pseud", ao3_user: "heldlogin" }],
      });
      const work = await t.db
        .selectFrom("works")
        .select(["status", "current_version_id"])
        .where("id", "=", seeded.workId)
        .executeTakeFirstOrThrow();
      expect(work).toEqual({ status: "held", current_version_id: seeded.versionId });
      const authors = await t.db
        .selectFrom("work_authors")
        .select(["pseud", "ao3_user"])
        .where("work_id", "=", seeded.workId)
        .execute();
      expect(authors).toEqual([{ pseud: "Held Pseud", ao3_user: "heldlogin" }]);
      expect(await getLiveWork(t.db, 8813705)).toBeNull();
      expect(await getWorkAvailability(t.db, 8813705)).toBeNull();
    });

    it("approving refuses a version whose byline is on the opt-out list, and keeps it held", async () => {
      const first = await seedWork(t.db, {
        ao3WorkId: 8813706,
        format: "pdf",
        heldFirst: "pdf_byline_unsure",
        authors: [{ pseud: "Shown Pseud", ao3_user: "optedlogin8813706" }],
      });
      const live = await seedWork(t.db, { ao3WorkId: 8813707 });
      const later = await seedVersion(t.db, live, {
        current: false,
        format: "pdf",
        holdReason: "pdf_more_chapters",
        chapters: 2,
        authors: [{ pseud: "optedlogin8813706", ao3_user: null }],
      });
      // The list holds the login: a login counts as a name, as at ingest.
      const request = await t.db
        .insertInto("requests")
        .values({
          kind: "opt_out",
          pseud_norm: "optedlogin8813706",
          contact_email: "requester@example.test",
          statement: "A short statement.",
          ip_hash: "hash-of-an-ip",
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      await t.db
        .insertInto("optouts")
        .values({ pseud_norm: "optedlogin8813706", request_id: request.id, active: true })
        .execute();

      expect(await approveVersion(t.db, first.workId, first.versionId)).toBe("opted_out");
      expect(await approveVersion(t.db, live.workId, later.versionId)).toBe("opted_out");
      const statuses = await t.db
        .selectFrom("uploads")
        .select("status")
        .where("id", "in", [first.uploadId, later.uploadId])
        .execute();
      expect(statuses.map((s) => s.status)).toEqual(["held_for_review", "held_for_review"]);
      const work = await t.db
        .selectFrom("works")
        .select("status")
        .where("id", "=", first.workId)
        .executeTakeFirstOrThrow();
      expect(work.status).toBe("held");
    });

    it("a held first upload can be removed, and an opt-out's hide keeps it held when restored", async () => {
      const removed = await seedWork(t.db, {
        ao3WorkId: 8813708,
        format: "pdf",
        heldFirst: "pdf_byline_unsure",
      });
      const moderator = await addModerator();
      expect((await removeWork(t.db, removed.workId, moderator))?.outcome).toBe("removed");

      const hidden = await seedWork(t.db, {
        ao3WorkId: 8813709,
        format: "pdf",
        heldFirst: "pdf_byline_unsure",
      });
      expect(await hideWork(t.db, hidden.workId, "removal_request")).toBe(true);
      expect(await restoreWork(t.db, hidden.workId, { cause: "removal_request" })).toBe(true);
      const after = await t.db
        .selectFrom("works")
        .select("status")
        .where("id", "=", hidden.workId)
        .executeTakeFirstOrThrow();
      expect(after.status).toBe("held");
    });

    it("an upload of the same file as a held first upload is a duplicate", async () => {
      const held = await seedWork(t.db, {
        ao3WorkId: 8813690,
        format: "pdf",
        heldFirst: "pdf_byline_unsure",
      });
      const { sha256 } = await t.db
        .selectFrom("uploads")
        .select("sha256")
        .where("id", "=", held.uploadId)
        .executeTakeFirstOrThrow();
      const again = crypto.randomUUID();
      await t.db
        .insertInto("uploads")
        .values({ id: again, user_id: held.userId, r2_key: `uploads/${again}`, bytes: 1 })
        .execute();
      expect(await recordUploadHash(t.db, again, sha256!)).toEqual({ duplicateOf: held.workId });
    });

    it("a held version keeps every reason it is held for", async () => {
      const { versionId } = await seedWork(t.db, { ao3WorkId: 8813691 });
      const row = await t.db
        .updateTable("work_versions")
        .set({ hold_reason: "pdf_byline_unsure", other_hold_reasons: ["pdf_more_chapters"] })
        .where("id", "=", versionId)
        .returning("other_hold_reasons")
        .executeTakeFirstOrThrow();
      expect(row.other_hold_reasons).toEqual(["pdf_more_chapters"]);
      // SAFETY: the check under test refuses what the type does.
      const notAReason = "not_a_reason" as "pdf_more_chapters";
      await expect(
        t.db
          .updateTable("work_versions")
          .set({ other_hold_reasons: [notAReason] })
          .where("id", "=", versionId)
          .execute(),
      ).rejects.toThrow();
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
