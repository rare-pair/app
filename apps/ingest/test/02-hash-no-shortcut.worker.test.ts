import { putFragments } from "@archive/db/seed";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { ao3Epub, zipEntries } from "../../../packages/epub/test/helpers";
import {
  beforePut,
  bucketKeys,
  freshAo3WorkId,
  ingestReal,
  seededWork,
  setWorkStatus,
  versionsOf,
  workExists,
} from "./helpers";

// U7's ingest halves of 02-upload-handshake's "no shortcut" cases: the web Worker's confirm
// enqueues such an upload (apps/web/test/02-upload-confirm.test.ts), and the job decides it.
// Ingest never reads the hash, so identical bytes are two uploads like any other.

/** A well-formed epub with no AO3 preface: rejected as `not_ao3`. Synthetic text. */
const notAo3Epub = () =>
  zipEntries({
    "META-INF/container.xml": `<container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>`,
    "OEBPS/content.opf": `<package xmlns="http://www.idpf.org/2007/opf" version="2.0">
      <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
        <dc:title>Elsewhere</dc:title><dc:creator>someone</dc:creator>
        <dc:identifier>urn:isbn:9780000000002</dc:identifier>
      </metadata>
      <manifest><item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/></manifest>
      <spine><itemref idref="c1"/></spine>
    </package>`,
    "OEBPS/c1.xhtml": `<html xmlns="http://www.w3.org/1999/xhtml"><body><p>plain text</p></body></html>`,
  });

describe("02-upload-handshake: hash matches that get no shortcut", () => {
  it("Hash match on an upload still being processed gets no shortcut", async () => {
    const bytes = ao3Epub({ workId: freshAo3WorkId() });

    const first = await ingestReal(bytes);
    const second = await ingestReal(bytes);

    // Once both are processed, the versioning rules mark the later one a duplicate.
    expect(first.row.status).toBe("live");
    expect(second.row.status).toBe("duplicate");
    expect(second.row.work_id).toBe(first.row.work_id);
    expect(await bucketKeys(`originals/${second.id}`)).toHaveLength(1);
  });

  it("Hash match on a rejected upload gets no shortcut", async () => {
    const bytes = notAo3Epub();

    const first = await ingestReal(bytes);
    const second = await ingestReal(bytes);

    for (const { row, result } of [first, second]) {
      expect(row.status).toBe("not_ao3");
      expect(row.work_id).toBeNull();
      expect(result.explicitAcks).toEqual(["msg-0"]);
    }
  });

  describe("Hash match on a removed work gets no shortcut", () => {
    /** Expects the job refused the upload as `work_removed`, and wrote nothing. */
    async function expectRefused(
      ao3WorkId: number,
      before: Awaited<ReturnType<typeof versionsOf>>,
      { id, row, result }: Awaited<ReturnType<typeof ingestReal>>,
    ) {
      expect(row.status).toBe("work_removed");
      expect(row.error_stage).toBe("save");
      expect(row.error).toBe("work_removed");
      expect(row.work_id).toBeNull();
      expect(row.lease_until).toBeNull();
      expect(result.explicitAcks).toEqual(["msg-0"]);
      expect(result.retryMessages).toEqual([]);
      expect(await bucketKeys(`works/${ao3WorkId}/${id}/`)).toEqual([]);
      expect(await bucketKeys(`originals/${id}`)).toEqual([]);
      expect(await versionsOf(ao3WorkId)).toEqual(before);
    }

    it("refuses it as work_removed when the work's files are purged", async () => {
      // As removal leaves it: no fragments in R2 (#398).
      const removed = await seededWork({ status: "removed" });
      const before = await versionsOf(removed.ao3WorkId);

      const upload = await ingestReal(ao3Epub({ workId: removed.ao3WorkId }));

      await expectRefused(removed.ao3WorkId, before, upload);
      expect(before.status).toBe("removed");
    });

    it("refuses it as work_removed when the work's files are still there", async () => {
      const removed = await seededWork({ status: "removed" });
      await putFragments(env.BUCKET, removed.fragments);
      const before = await versionsOf(removed.ao3WorkId);

      const upload = await ingestReal(ao3Epub({ workId: removed.ao3WorkId }));

      await expectRefused(removed.ao3WorkId, before, upload);
    });

    it("refuses it when the work is removed after the job read it", async () => {
      const live = await seededWork({});
      await putFragments(env.BUCKET, live.fragments);
      const bucket = beforePut(async (key) => {
        if (key.startsWith("originals/")) await setWorkStatus(live.ao3WorkId, "removed");
      });
      const before = await versionsOf(live.ao3WorkId);

      const { row, result } = await ingestReal(ao3Epub({ workId: live.ao3WorkId }), { bucket });

      expect(row.status).toBe("work_removed");
      expect(row.work_id).toBeNull();
      expect(result.explicitAcks).toEqual(["msg-0"]);
      expect(result.retryMessages).toEqual([]);
      expect(await versionsOf(live.ao3WorkId)).toEqual({ ...before, status: "removed" });
    });

    it("accepts an upload of a work restored to live", async () => {
      const work = await seededWork({ status: "removed" });
      await putFragments(env.BUCKET, work.fragments);
      await setWorkStatus(work.ao3WorkId, "live");

      const { row } = await ingestReal(ao3Epub({ workId: work.ao3WorkId }));

      expect(["live", "held_for_review", "duplicate"]).toContain(row.status);
    });

    it("saves the first upload of a work no one has uploaded", async () => {
      const workId = freshAo3WorkId();

      const { row } = await ingestReal(ao3Epub({ workId }));

      expect(row.status).toBe("live");
      expect(await workExists(workId)).toBe(true);
    });
  });
});
