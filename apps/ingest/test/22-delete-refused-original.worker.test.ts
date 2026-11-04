import { createDb } from "@archive/db";
import { processEpub } from "@archive/epub";
import { env } from "cloudflare:workers";
import type { KyselyPlugin } from "kysely";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ao3Epub } from "../../../packages/epub/test/helpers";
import { runJob } from "../src/job";
import { SaveRejected, saveWork } from "../src/save";
import {
  addOptOut,
  banUploader,
  bucketKeys,
  deliver,
  parsedWork,
  pendingUpload,
  seededWork,
  setLease,
  token,
  uploadRow,
  watchedWorker,
} from "./helpers";
import type { Steps } from "../src/worker";

// ORIG (#576): an upload refused after its raw epub was stored deletes that one file. AO3 work
// ids 42700-42799 are this file's. Synthetic text only.

afterEach(() => vi.restoreAllMocks());

/** The key a job writes the upload's raw file to. */
const original = (id: string) => `originals/${id}.epub`;

/** Random text a tag index can't take (random hex, so compression can't shrink it). */
const hugeTag = () => Array.from({ length: 250 }, () => crypto.randomUUID()).join("");

/** A bucket step whose `delete` runs `hook` first, with the keys it is asked to delete. */
const beforeDelete =
  (hook: (keys: string[]) => Promise<void>): NonNullable<Steps["bucket"]> =>
  (real) => ({
    get: real.get.bind(real),
    list: real.list.bind(real),
    put: real.put.bind(real),
    delete: async (keys) => {
      await hook(Array.isArray(keys) ? keys : [keys]);
      return real.delete(keys);
    },
  });

/** Stores the upload's file as an earlier attempt's save would, then fails like R2 going down. */
const storesThenFails: Steps["save"] = async (upload, _work, bytes) => {
  await env.BUCKET.put(original(upload.id), bytes);
  throw new Error("injected failure after the original was stored");
};

/** Runs the job on `work`, whose upload has its own epub, with the real save. */
async function ingestRefused(work: ReturnType<typeof parsedWork>, steps: Partial<Steps> = {}) {
  const id = await pendingUpload(ao3Epub({ workId: Number(work.ao3WorkId) }));
  const { handler } = watchedWorker({ process: async () => work, ...steps });
  const result = await deliver([{ upload_id: id }], { handler });
  return { id, row: await uploadRow(id), result };
}

describe("ORIG: a save refused inside its transaction deletes the original", () => {
  it("deletes it for a unique violation (class 23)", async () => {
    const work = parsedWork({
      ao3WorkId: "42700",
      chapters: [
        { n: 1, title: "One", html: "<p>one</p>", words: 1 },
        { n: 1, title: "Again", html: "<p>again</p>", words: 1 },
      ],
    });
    const log = vi.spyOn(console, "log");

    const { id, row, result } = await ingestRefused(work);

    expect(row).toMatchObject({ status: "parse_failed", error: "save_rejected_23505" });
    expect(await bucketKeys(`originals/${id}`)).toEqual([]);
    expect(result.explicitAcks).toEqual(["msg-0"]);
    expect(result.retryMessages).toEqual([]);
    // The id and a count: nothing from the file.
    expect(log).toHaveBeenCalledWith({
      event: "ingest.refused_original_deleted",
      uploadId: id,
      deleted: 1,
    });
  });

  it("deletes it for a value over a database limit (class 54)", async () => {
    const { id, row } = await ingestRefused(
      parsedWork({ ao3WorkId: "42701", freeforms: [hugeTag()] }),
    );

    expect(row).toMatchObject({ status: "parse_failed", error: "save_rejected_54000" });
    expect(await bucketKeys(`originals/${id}`)).toEqual([]);
  });

  it.each([
    [21, "21000", 42702],
    [22, "22021", 42703],
  ])("deletes it for a class %i error the file causes", async (_class, state, workId) => {
    const id = await pendingUpload(ao3Epub({ workId }));
    // No column of ours raises these on demand (the sanitizer strips what Postgres would
    // refuse in text): the chapters insert fails as the database's own error would.
    const refuseChapters: KyselyPlugin = {
      transformQuery: ({ node }) => {
        if (JSON.stringify(node).includes('"chapters"')) {
          throw Object.assign(new Error("injected"), { code: state });
        }
        return node;
      },
      transformResult: ({ result }) => Promise.resolve(result),
    };
    const db = createDb({ connectionString: env.HYPERDRIVE.connectionString, max: 1 });
    try {
      const verdict = await runJob(
        {
          db,
          bucket: env.BUCKET,
          process: async (bytes) => ({ ...(await processEpub(bytes)), ao3WorkId: String(workId) }),
          save: (lease, work, bytes, images) =>
            saveWork(
              { db: db.withPlugin(refuseChapters), bucket: env.BUCKET },
              lease,
              work,
              bytes,
              images,
            ),
        },
        id,
        1,
      );
      expect(verdict).toBe("ack");
    } finally {
      await db.destroy();
    }

    expect(await uploadRow(id)).toMatchObject({
      status: "parse_failed",
      error: `save_rejected_${state}`,
    });
    expect(await bucketKeys(`originals/${id}`)).toEqual([]);
  });

  it("deletes it for a ban that lands while the job runs", async () => {
    const work = parsedWork({ ao3WorkId: "42704" });
    const id = await pendingUpload(ao3Epub({ workId: 42704 }));
    const { handler } = watchedWorker({
      process: async () => {
        await banUploader(id);
        return work;
      },
    });

    await deliver([{ upload_id: id }], { handler });

    expect(await uploadRow(id)).toMatchObject({ status: "account_banned", error_stage: "save" });
    expect(await bucketKeys(`originals/${id}`)).toEqual([]);
  });
});

describe("ORIG: a retry that ends refused deletes what the earlier attempt stored", () => {
  it("deletes it when the retry ends opted_out", async () => {
    const pseud = `orig${token()}`;
    const id = await pendingUpload(ao3Epub({ workId: 42705 }));
    const byline = async (bytes: Uint8Array) => ({
      ...(await processEpub(bytes)),
      authors: [{ pseud, user: null }],
    });
    const first = watchedWorker({ process: byline, save: storesThenFails });
    const one = await deliver([{ upload_id: id }], { handler: first.handler });
    expect(one.retryMessages).toEqual([{ msgId: "msg-0" }]);
    expect(await bucketKeys(`originals/${id}`)).toEqual([original(id)]);
    expect((await uploadRow(id)).status).toBe("pending");
    // The opt-out arrives between the attempts.
    await addOptOut(pseud);

    const second = watchedWorker({ process: byline });
    const two = await deliver([{ upload_id: id }], { handler: second.handler, attempts: 2 });

    expect(await uploadRow(id)).toMatchObject({ status: "opted_out", error: "opted_out" });
    expect(await bucketKeys(`originals/${id}`)).toEqual([]);
    expect(two.explicitAcks).toEqual(["msg-0"]);
  });

  it("deletes it when a ban lands between the attempts", async () => {
    const id = await pendingUpload(ao3Epub({ workId: 42706 }));
    const first = watchedWorker({ save: storesThenFails });
    await deliver([{ upload_id: id }], { handler: first.handler });
    await banUploader(id);

    await deliver([{ upload_id: id }], { handler: watchedWorker().handler, attempts: 2 });

    expect(await uploadRow(id)).toMatchObject({ status: "account_banned", error_stage: "read" });
    expect(await bucketKeys(`originals/${id}`)).toEqual([]);
  });

  it("deletes it when the last attempt fails for good, and the message goes to the DLQ", async () => {
    const id = await pendingUpload(ao3Epub({ workId: 42707 }));
    const { handler } = watchedWorker({ save: storesThenFails });

    const result = await deliver([{ upload_id: id }], { handler, attempts: 4 });

    expect(await uploadRow(id)).toMatchObject({ status: "parse_failed", error_stage: "save" });
    expect(result.retryMessages).toEqual([{ msgId: "msg-0" }]);
    expect(await bucketKeys(`originals/${id}`)).toEqual([]);
  });

  it("keeps the outcome when the delete itself fails", async () => {
    const id = await pendingUpload(ao3Epub({ workId: 42708 }));
    const error = vi.spyOn(console, "error");
    const { handler } = watchedWorker({
      save: storesThenFails,
      bucket: beforeDelete(async () => {
        throw new Error("injected R2 failure");
      }),
    });

    const result = await deliver([{ upload_id: id }], { handler, attempts: 4 });

    // Final and recorded: the failed delete changes neither the row nor the verdict.
    expect(await uploadRow(id)).toMatchObject({ status: "parse_failed", error_stage: "save" });
    expect(result.retryMessages).toEqual([{ msgId: "msg-0" }]);
    expect(await bucketKeys(`originals/${id}`)).toEqual([original(id)]);
    expect(error).toHaveBeenCalledWith({
      event: "ingest.refused_original_delete_failed",
      uploadId: id,
      error: "Error",
    });
  });
});

describe("ORIG: a job that lost its lease deletes nothing a takeover shares", () => {
  it("leaves the original when the upload is taken over just before the job ends it", async () => {
    const id = await pendingUpload(ao3Epub({ workId: 42709 }));
    // SAFETY: assigned in the save below, before it is read.
    let takenOver = null as Date | null;
    const { handler } = watchedWorker({
      // This job stores the file, loses the upload to another job, then finds the file refused.
      save: async (upload, _work, bytes) => {
        await env.BUCKET.put(original(upload.id), bytes);
        takenOver = await setLease(id, "1 hour");
        throw new SaveRejected("save_rejected_23505");
      },
    });

    const result = await deliver([{ upload_id: id }], { handler });

    expect(await bucketKeys(`originals/${id}`)).toEqual([original(id)]);
    const row = await uploadRow(id);
    expect(row.status).toBe("processing");
    expect(row.lease_until).toEqual(takenOver);
    expect(result.explicitAcks).toEqual(["msg-0"]);
  });

  it("deletes only after the upload is ended, and an ended upload can't be claimed", async () => {
    const id = await pendingUpload(ao3Epub({ workId: 42711 }));
    const takeover: string[] = [];
    // SAFETY: assigned in the delete hook below, before it is read.
    let atDelete = null as Awaited<ReturnType<typeof uploadRow>> | null;
    const { handler } = watchedWorker({
      process: async () => parsedWork({ ao3WorkId: "42711", freeforms: [hugeTag()] }),
      bucket: beforeDelete(async () => {
        // The row as the delete finds it: a delete before the ending write sees `processing`.
        atDelete ??= await uploadRow(id);
        // Another delivery of the same upload arrives while the delete is in flight.
        const again = watchedWorker({ save: async (upload) => void takeover.push(upload.id) });
        await deliver([{ upload_id: id }], { handler: again.handler });
      }),
    });

    await deliver([{ upload_id: id }], { handler });

    expect(atDelete).toMatchObject({ status: "parse_failed", lease_until: null });
    expect(takeover).toEqual([]);
    expect(await bucketKeys(`originals/${id}`)).toEqual([]);
  });
});

describe("ORIG: what the delete leaves alone", () => {
  it("keeps the original of an attempt that will be retried", async () => {
    const id = await pendingUpload(ao3Epub({ workId: 42712 }));
    const { handler } = watchedWorker({ save: storesThenFails });

    const result = await deliver([{ upload_id: id }], { handler, attempts: 1 });

    expect(result.retryMessages).toEqual([{ msgId: "msg-0" }]);
    expect((await uploadRow(id)).status).toBe("pending");
    expect(await bucketKeys(`originals/${id}`)).toEqual([original(id)]);
  });

  it("logs nothing when a refusal had stored no original", async () => {
    const id = await pendingUpload(ao3Epub({ workId: 42713 }));
    await banUploader(id);
    const log = vi.spyOn(console, "log");

    await deliver([{ upload_id: id }], { handler: watchedWorker().handler });

    expect(await uploadRow(id)).toMatchObject({ status: "account_banned", error_stage: "read" });
    expect(log).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: "ingest.refused_original_deleted" }),
    );
  });

  it("deletes a removed work's original once: the save's clean-up, not the job's ending", async () => {
    await seededWork({ ao3WorkId: 42714, status: "removed" });
    const id = await pendingUpload(ao3Epub({ workId: 42714 }));
    const deletes: string[][] = [];
    const { handler } = watchedWorker({
      bucket: beforeDelete(async (keys) => void deletes.push(keys)),
    });

    await deliver([{ upload_id: id }], { handler });

    expect(await uploadRow(id)).toMatchObject({ status: "work_removed" });
    expect(deletes.filter((keys) => keys.includes(original(id)))).toHaveLength(1);
  });
});
