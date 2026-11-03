import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ao3Epub } from "../../../packages/epub/test/helpers";
import type { Steps } from "../src/worker";
import {
  beforePut,
  bucketKeys,
  deliver,
  gated,
  parsedWork,
  pendingUpload,
  savedRows,
  seededWork,
  setLease,
  setWorkStatus,
  uploadRow,
  watchedWorker,
} from "./helpers";

// LEASE (#511): a running job renews its lease, and a job that has lost it stops before
// writing. AO3 work ids 41400-41499 are this file's. The lease clock is Postgres's, so these
// cases wait in real time, with a lease of 3 s that is renewed every 0.5 s.

/** A short lease for the tests: long enough to be held, short enough to outwait. */
const SHORT: NonNullable<Steps["timing"]> = { seconds: 3, renewSeconds: 0.5 };

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe("LEASE: a job that runs longer than its lease", () => {
  it("keeps the lease, so a duplicate delivery does no work", async () => {
    const workId = 41400;
    const id = await pendingUpload(ao3Epub({ workId }));
    const gate = gated();
    const first = watchedWorker({ process: gate.process, timing: SHORT });
    const second = watchedWorker({ timing: SHORT });

    const running = deliver([{ upload_id: id }], { handler: first.handler });
    await gate.entered;
    const claimed = (await uploadRow(id)).lease_until;
    // Held past the 3 s lease: without renewal, the lease has run out by now.
    await sleep(4500);
    const renewed = (await uploadRow(id)).lease_until;
    const secondResult = await deliver([{ upload_id: id }], { handler: second.handler });
    gate.release();
    const firstResult = await running;

    expect(renewed!.getTime()).toBeGreaterThan(claimed!.getTime());
    expect(second.parsed).toHaveLength(0);
    expect(secondResult.explicitAcks).toEqual(["msg-0"]);
    expect(firstResult.explicitAcks).toEqual(["msg-0"]);
    expect((await uploadRow(id)).status).toBe("live");
    expect((await savedRows(workId, id)).versions).toHaveLength(1);
  }, 30_000);

  it("still ends live when it finishes right after a renewal", async () => {
    const workId = 41401;
    const id = await pendingUpload(ao3Epub({ workId }));
    // Renewing every 10 ms through the whole job, the writes and the transaction included.
    const { handler } = watchedWorker({
      timing: { seconds: 3, renewSeconds: 0.01 },
      process: async () => {
        await sleep(300);
        return parsedWork({ ao3WorkId: String(workId) });
      },
    });

    const result = await deliver([{ upload_id: id }], { handler });

    const row = await uploadRow(id);
    expect(row.status).toBe("live");
    expect(row.lease_until).toBeNull();
    expect(result.explicitAcks).toEqual(["msg-0"]);
  }, 30_000);
});

describe("LEASE: a job that has lost its lease", () => {
  afterEach(() => vi.restoreAllMocks());

  it("stops writing and says so in its log when another job takes over mid-save", async () => {
    const workId = 41402;
    const chapters = 60;
    const id = await pendingUpload(ao3Epub({ workId }));
    const warn = vi.spyOn(console, "warn");
    // SAFETY: the bucket's put below assigns it; null until then.
    let takenOver = null as Date | null;
    const { handler } = watchedWorker({
      timing: SHORT,
      process: async () =>
        parsedWork({
          ao3WorkId: String(workId),
          chapters: Array.from({ length: chapters }, (_, i) => ({
            n: i + 1,
            title: `Chapter ${i + 1}`,
            html: "<p>synthetic text.</p>",
            words: 3,
          })),
        }),
      // Another job claims the upload with the first fragment, as after a lease ran out. Each
      // write takes 300 ms, so the renewal that finds the loss lands within a few rounds.
      bucket: beforePut(async (key) => {
        if (key.endsWith("/1.html")) takenOver = await setLease(id, "1 hour");
        await sleep(300);
      }),
    });

    const result = await deliver([{ upload_id: id }], { handler });

    expect((await bucketKeys(`works/${workId}/${id}/`)).length).toBeLessThan(chapters);
    expect(await bucketKeys(`originals/${id}`)).toEqual([]);
    expect((await savedRows(workId, id)).works).toEqual([]);
    const row = await uploadRow(id);
    expect(row.status).toBe("processing");
    expect(row.lease_until).toEqual(takenOver);
    expect(result.explicitAcks).toEqual(["msg-0"]);
    expect(result.retryMessages).toEqual([]);
    expect(warn).toHaveBeenCalledWith({ event: "ingest.lease_lost", uploadId: id, stage: "save" });
  }, 30_000);

  it("writes nothing when another job takes over during the process step", async () => {
    const workId = 41403;
    const id = await pendingUpload(ao3Epub({ workId }));
    const { handler } = watchedWorker({
      timing: SHORT,
      process: async () => {
        await setLease(id, "1 hour");
        return parsedWork({ ao3WorkId: String(workId) });
      },
    });

    const result = await deliver([{ upload_id: id }], { handler });

    expect(await bucketKeys(`works/${workId}/`)).toEqual([]);
    expect(await bucketKeys(`originals/${id}`)).toEqual([]);
    expect((await uploadRow(id)).status).toBe("processing");
    expect(result.explicitAcks).toEqual(["msg-0"]);
  });

  it("leaves the files to the job that took over when the work is removed too", async () => {
    const workId = 41404;
    const live = await seededWork({ ao3WorkId: workId });
    const id = await pendingUpload(ao3Epub({ workId }));
    // What the job that took the upload over has written by now.
    const theirs = [`originals/${id}.epub`, `works/${workId}/${id}/1.html`];
    for (const key of theirs) await env.BUCKET.put(key, "the other job's file");
    const log = vi.spyOn(console, "log");
    // The current version's fragment is missing and the work is removed: the save reads it as
    // a removal. In the same moment another job takes the upload over.
    const { handler } = watchedWorker({
      timing: SHORT,
      bucket: (real) => ({
        get: async (key) => {
          if (key === live.chapterKeys[0]) {
            await setWorkStatus(workId, "removed");
            await setLease(id, "1 hour");
          }
          return real.get(key);
        },
        put: real.put.bind(real),
        list: real.list.bind(real),
        delete: real.delete.bind(real),
      }),
    });

    const result = await deliver([{ upload_id: id }], { handler });

    expect(await bucketKeys(`originals/${id}`)).toEqual([theirs[0]]);
    expect(await bucketKeys(`works/${workId}/${id}/`)).toEqual([theirs[1]]);
    expect(log).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: "ingest.lost_to_removal" }),
    );
    expect((await uploadRow(id)).status).toBe("processing");
    expect(result.explicitAcks).toEqual(["msg-0"]);
  });
});
