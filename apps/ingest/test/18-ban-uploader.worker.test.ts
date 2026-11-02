import { describe, expect, it } from "vitest";
import { ao3Epub } from "../../../packages/epub/test/helpers";
import {
  banUploader,
  deliver,
  freshAo3WorkId,
  parsedWork,
  pendingUpload,
  savedRows,
  uploadRow,
  watchedWorker,
} from "./helpers";

// MOD6: a ban stops the account's in-flight uploads. Ingest refuses a job whose uploader is
// banned at its start, and again in the save's transaction, as for a removed work.

describe("18-moderation: Moderator bans an uploader", () => {
  it("A banned uploader's job is refused as account_banned before the file is read", async () => {
    const id = await pendingUpload(ao3Epub({ workId: freshAo3WorkId() }));
    await banUploader(id);
    const saved: string[] = [];
    const { handler, parsed } = watchedWorker({
      save: async (upload) => void saved.push(upload.id),
    });

    const result = await deliver([{ upload_id: id }], { handler });

    const row = await uploadRow(id);
    expect(row.status).toBe("account_banned");
    expect(row.error_stage).toBe("read");
    expect(row.error).toBe("account_banned");
    expect(row.work_id).toBeNull();
    expect(row.lease_until).toBeNull();
    expect(parsed).toEqual([]);
    expect(saved).toEqual([]);
    expect(result.explicitAcks).toEqual(["msg-0"]);
    expect(result.retryMessages).toEqual([]);
  });

  it("An uploader who is not banned is saved", async () => {
    const id = await pendingUpload(ao3Epub({ workId: freshAo3WorkId() }));
    const saved: string[] = [];
    const { handler } = watchedWorker({ save: async (upload) => void saved.push(upload.id) });

    await deliver([{ upload_id: id }], { handler });

    expect(saved).toEqual([id]);
  });

  it("A ban that lands while the job runs is refused in the save's transaction", async () => {
    const work = parsedWork();
    const id = await pendingUpload(ao3Epub({ workId: Number(work.ao3WorkId) }));
    // Banned after the job's first check, while the file is processed.
    const { handler } = watchedWorker({
      process: async () => {
        await banUploader(id);
        return work;
      },
    });

    const result = await deliver([{ upload_id: id }], { handler });

    const row = await uploadRow(id);
    expect(row.status).toBe("account_banned");
    expect(row.error_stage).toBe("save");
    expect(row.error).toBe("account_banned");
    expect(row.work_id).toBeNull();
    expect(row.lease_until).toBeNull();
    const rows = await savedRows(Number(work.ao3WorkId), id);
    expect(rows.works).toEqual([]);
    expect(rows.versions).toEqual([]);
    expect(result.explicitAcks).toEqual(["msg-0"]);
    expect(result.retryMessages).toEqual([]);
  });
});
