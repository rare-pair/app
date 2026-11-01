import { putFragments } from "@archive/db/seed";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { ao3Epub } from "../../../packages/epub/test/helpers";
import {
  beforePut,
  bucketKeys,
  bucketText,
  deliver,
  seededWork,
  failingPut,
  gated,
  liveWork,
  freshAo3WorkId,
  parsedWork,
  pendingUpload,
  savedRows,
  searchedIds,
  setLease,
  token,
  uploadRow,
  watchedPuts,
  watchedWorker,
} from "./helpers";
import type { Steps } from "../src/worker";

// The lease cases look at the upload while its job holds it: their save leaves it `processing`.
const holding: Partial<Steps> = { save: async () => {} };

describe("04-ingest-job-lifecycle", () => {
  it("Retry overwrites only its own output", async () => {
    const workId = freshAo3WorkId();
    const id = await pendingUpload(ao3Epub({ workId }));
    const own = `works/${workId}/${id}/1.html`;
    const others = `works/${workId}/${crypto.randomUUID()}/1.html`;
    await env.BUCKET.put(own, "stale output of an earlier attempt");
    await env.BUCKET.put(others, "another upload's fragment");
    // The first attempt writes the fragments, then fails before the transaction.
    const { handler } = watchedWorker({ bucket: failingPut(`originals/${id}.epub`) });
    const first = await deliver([{ upload_id: id }], { handler });
    expect(first.retryMessages.map((m) => m.msgId)).toEqual(["msg-0"]);

    const retry = await deliver([{ upload_id: id }], { attempts: 2 });

    expect(await bucketText(own)).toContain("marker-only-chapter text.");
    expect(await bucketText(others)).toBe("another upload's fragment");
    expect(await bucketKeys(`works/${workId}/`)).toEqual([own, others].sort());
    expect((await uploadRow(id)).status).toBe("live");
    expect(retry.explicitAcks).toEqual(["msg-0"]);
  });

  it("Successful job saves in order and goes live last", async () => {
    const workId = freshAo3WorkId();
    const id = await pendingUpload(ao3Epub({ workId }));
    const watched = watchedPuts(workId);
    const { handler } = watchedWorker({ bucket: watched.bucket });

    try {
      await deliver([{ upload_id: id }], { handler });
    } finally {
      await watched.close();
    }

    // R2 first: no work row existed while the fragment and the original were written.
    expect(watched.puts).toEqual([
      { key: `works/${workId}/${id}/1.html`, workExisted: false },
      { key: `originals/${id}.epub`, workExisted: false },
    ]);
    // Then the transaction. The order inside it can't be seen from outside; "Failure inside
    // the transaction rolls back" shows it is one transaction.
    const live = await liveWork(workId);
    expect(live?.work.status).toBe("live");
    expect(live?.version.r2_prefix).toBe(`works/${workId}/${id}/`);
    expect(live?.chapters.map((c) => c.r2_key)).toEqual([`works/${workId}/${id}/1.html`]);
    expect(live?.tags.map((t) => t.name)).toEqual([
      "General Audiences",
      "No Archive Warnings Apply",
      "Test Fandom",
      "Tag A",
      "Tag & B",
    ]);
    expect(await uploadRow(id)).toEqual({
      status: "live",
      lease_until: null,
      error_stage: null,
      error: null,
      work_id: live?.work.id,
    });
  });

  it("Failure before the transaction leaves nothing in Postgres", async () => {
    const tag = `Freeform ${crypto.randomUUID()}`;
    const work = parsedWork({
      freeforms: [tag],
      chapters: [
        { n: 1, title: "One", html: "<p>one</p>", words: 1 },
        { n: 2, title: "Two", html: "<p>two</p>", words: 1 },
      ],
    });
    const workId = Number(work.ao3WorkId);
    const id = await pendingUpload(ao3Epub({ workId }));
    // The fragments are written, then R2 fails on the original: the transaction never starts.
    const { handler } = watchedWorker({
      process: async () => work,
      bucket: failingPut(`originals/${id}.epub`),
    });

    const result = await deliver([{ upload_id: id }], { handler });

    expect(await savedRows(workId, id, [tag])).toEqual({ works: [], versions: [], tags: [] });
    expect(await bucketKeys(`works/${workId}/`)).toEqual([
      `works/${workId}/${id}/1.html`,
      `works/${workId}/${id}/2.html`,
    ]);
    // Worth a retry, as R2 being down is.
    expect((await uploadRow(id)).status).toBe("pending");
    expect(result.retryMessages.map((m) => m.msgId)).toEqual(["msg-0"]);

    await deliver([{ upload_id: id }], { attempts: 4, handler });

    expect(await savedRows(workId, id, [tag])).toEqual({ works: [], versions: [], tags: [] });
    const row = await uploadRow(id);
    expect(row.status).toBe("parse_failed");
    expect(row.error_stage).toBe("save");
    expect(row.error).toBe("Error");
  });

  it("A saved work is searchable by its title and tags", async () => {
    const word = `Marigold${token()}`;
    const tag = `Tag${token()}`;
    const work = parsedWork({ title: `The ${word} Lantern`, freeforms: [tag] });
    const workId = Number(work.ao3WorkId);
    const id = await pendingUpload(ao3Epub({ workId }));
    const { handler } = watchedWorker({ process: async () => work });

    await deliver([{ upload_id: id }], { handler });

    expect(await searchedIds(word)).toEqual([workId]);
    expect(await searchedIds(tag)).toEqual([workId]);
  });

  it("A save that rolls back leaves nothing to search", async () => {
    const word = `Quince${token()}`;
    const work = parsedWork({
      title: `The ${word} Lantern`,
      chapters: [
        { n: 1, title: "One", html: "<p>one</p>", words: 1 },
        { n: 1, title: "Again", html: "<p>again</p>", words: 1 },
      ],
    });
    const id = await pendingUpload(ao3Epub({ workId: Number(work.ao3WorkId) }));
    const { handler } = watchedWorker({ process: async () => work });

    await deliver([{ upload_id: id }], { handler });

    expect(await searchedIds(word)).toEqual([]);
  });

  it("Failure inside the transaction rolls back", async () => {
    const tag = `Freeform ${crypto.randomUUID()}`;
    // Two chapters numbered 1: the chapters insert fails on its primary key, after the work,
    // its authors, its tags and its version are written.
    const work = parsedWork({
      freeforms: [tag],
      chapters: [
        { n: 1, title: "One", html: "<p>one</p>", words: 1 },
        { n: 1, title: "Again", html: "<p>again</p>", words: 1 },
      ],
    });
    const workId = Number(work.ao3WorkId);
    const id = await pendingUpload(ao3Epub({ workId }));
    const { handler } = watchedWorker({ process: async () => work });

    const result = await deliver([{ upload_id: id }], { handler });

    expect(await savedRows(workId, id, [tag])).toEqual({ works: [], versions: [], tags: [] });
    // The file's own data broke a rule, as it would on every attempt: recorded at once.
    expect(await uploadRow(id)).toEqual({
      status: "parse_failed",
      lease_until: null,
      error_stage: "save",
      error: "save_rejected_23505",
      work_id: null,
    });
    expect(result.explicitAcks).toEqual(["msg-0"]);
    expect(result.retryMessages).toEqual([]);
  });

  it("A first upload that finds another job saved the work meanwhile is decided as a later one", async () => {
    // Another job saves the work while this one writes R2: this job found no work when it
    // read, finds one inside its transaction, rolls back, and decides again against it.
    const workId = freshAo3WorkId();
    const id = await pendingUpload(ao3Epub({ workId }));
    // SAFETY: the bucket's put below assigns it; null until then.
    let existing = null as Awaited<ReturnType<typeof seededWork>> | null;
    const { handler } = watchedWorker({
      bucket: beforePut(async (key) => {
        if (!key.startsWith("originals/")) return;
        existing = await seededWork({ ao3WorkId: workId });
        await putFragments(env.BUCKET, existing.fragments);
      }),
    });

    const result = await deliver([{ upload_id: id }], { handler });

    // Not newer than the saved version (one chapter, an earlier date): a duplicate, with no
    // version of its own, and the work still at the version the other job saved.
    const live = await liveWork(workId);
    expect(live?.version.id).toBe(existing?.versionId);
    expect(live?.chapters.map((c) => c.r2_key)).toEqual(existing?.chapterKeys);
    expect((await savedRows(workId, id)).versions).toEqual([]);
    expect(await uploadRow(id)).toMatchObject({
      status: "duplicate",
      work_id: live?.work.id,
      error: null,
    });
    expect(result.explicitAcks).toEqual(["msg-0"]);
    expect(result.retryMessages).toEqual([]);
  });

  it("keeps an upload of a known work's files, whatever it is decided", async () => {
    const existing = await seededWork({ ao3WorkId: freshAo3WorkId(), chapters: 2 });
    await putFragments(env.BUCKET, existing.fragments);
    const before = await savedRows(existing.ao3WorkId, existing.uploadId);
    const id = await pendingUpload(ao3Epub({ workId: existing.ao3WorkId }));

    const result = await deliver([{ upload_id: id }]);

    // One chapter and an earlier date than the saved two: a duplicate. It changes nothing.
    expect(await savedRows(existing.ao3WorkId, existing.uploadId)).toEqual(before);
    expect(before.works[0]?.current_version_id).toBe(existing.versionId);
    const live = await liveWork(existing.ao3WorkId);
    expect(live?.chapters.map((c) => c.r2_key)).toEqual(existing.chapterKeys);
    expect((await savedRows(existing.ao3WorkId, id)).versions).toEqual([]);
    // Stored but not used: its fragments and its original are kept.
    expect(await bucketKeys(`works/${existing.ao3WorkId}/${id}/`)).toEqual([
      `works/${existing.ao3WorkId}/${id}/1.html`,
    ]);
    expect(await bucketKeys(`originals/${id}`)).toEqual([`originals/${id}.epub`]);
    const row = await uploadRow(id);
    expect(row.status).toBe("duplicate");
    expect(row.work_id).toBe(existing.workId);
    expect(result.explicitAcks).toEqual(["msg-0"]);
  });

  it("acks without writing when another job takes the upload over during the save", async () => {
    const workId = freshAo3WorkId();
    const id = await pendingUpload(ao3Epub({ workId }));
    // SAFETY: the bucket's put below assigns it; null until then.
    let takenOver = null as Date | null;
    const { handler } = watchedWorker({
      // Another job claims the upload while this one writes R2, as after a lease ran out.
      bucket: beforePut(async (key) => {
        if (key.startsWith("originals/")) takenOver = await setLease(id, "1 hour");
      }),
    });

    const result = await deliver([{ upload_id: id }], { handler });

    expect((await savedRows(workId, id)).works).toEqual([]);
    const row = await uploadRow(id);
    expect(row.status).toBe("processing");
    expect(row.lease_until).toEqual(takenOver);
    expect(row.error).toBeNull();
    expect(result.explicitAcks).toEqual(["msg-0"]);
    expect(result.retryMessages).toEqual([]);
  });

  it("records a work ID that doesn't fit, or a work with no chapters, at once", async () => {
    for (const [work, code] of [
      [parsedWork({ ao3WorkId: "2147483648" }), "bad_work_id"],
      [parsedWork({ chapters: [] }), "no_chapters"],
    ] as const) {
      const id = await pendingUpload(ao3Epub({ workId: freshAo3WorkId() }));
      const { handler } = watchedWorker({ process: async () => work });

      const result = await deliver([{ upload_id: id }], { handler });

      const row = await uploadRow(id);
      expect(row.status).toBe("parse_failed");
      expect(row.error_stage).toBe("save");
      expect(row.error).toBe(code);
      expect(result.explicitAcks).toEqual(["msg-0"]);
      expect(await bucketKeys(`originals/${id}`)).toEqual([]);
    }
  });

  it("records a value over a database limit at once", async () => {
    // A tag too long for its index (random hex, so compression can't shrink it under the limit).
    const huge = Array.from({ length: 250 }, () => crypto.randomUUID()).join("");
    const work = parsedWork({ freeforms: [huge] });
    const id = await pendingUpload(ao3Epub({ workId: Number(work.ao3WorkId) }));
    const { handler } = watchedWorker({ process: async () => work });

    const result = await deliver([{ upload_id: id }], { handler });

    expect(await uploadRow(id)).toMatchObject({
      status: "parse_failed",
      error_stage: "save",
      error: "save_rejected_54000",
    });
    expect(result.explicitAcks).toEqual(["msg-0"]);
  });

  it("saves a work with more chapters and tags than one INSERT takes", async () => {
    const count = 1_001;
    const work = parsedWork({
      chapters: Array.from({ length: count }, (_, i) => ({
        n: i + 1,
        title: `Chapter ${i + 1}`,
        html: "<p>x</p>",
        words: 1,
      })),
      freeforms: Array.from(
        { length: count },
        (_, i) => `Long work tag ${i} ${crypto.randomUUID()}`,
      ),
      stats: {
        published: null,
        updated: null,
        completed: null,
        words: null,
        chapters: { posted: count, total: null },
      },
    });
    const workId = Number(work.ao3WorkId);
    const id = await pendingUpload(ao3Epub({ workId }));
    const { handler } = watchedWorker({ process: async () => work });

    await deliver([{ upload_id: id }], { handler });

    const live = await liveWork(workId);
    expect(live?.chapters).toHaveLength(1_001);
    expect(live?.chapters.at(-1)?.r2_key).toBe(`works/${workId}/${id}/1001.html`);
    // The rating, the warning and the fandom, then the freeforms in the author's order.
    expect(live?.tags).toHaveLength(1_004);
    expect(live?.tags.at(-1)?.name).toBe(work.freeforms.at(-1));
    expect(live?.work.words).toBe(1_001);
  });

  it("Original file is kept", async () => {
    const epub = ao3Epub({ workId: freshAo3WorkId() });
    const id = await pendingUpload(epub);

    await deliver([{ upload_id: id }]);

    expect((await uploadRow(id)).status).toBe("live");
    const original = await env.BUCKET.get(`originals/${id}.epub`);
    // Sizes and digests, not bytes: a failing diff of a whole epub would print all of it.
    expect(original?.size).toBe(epub.byteLength);
    const digest = async (data: BufferSource) =>
      Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", data)), (b) =>
        b.toString(16).padStart(2, "0"),
      ).join("");
    expect(await digest((await original?.arrayBuffer()) ?? new ArrayBuffer(0))).toBe(
      await digest(epub),
    );
    // The upload's own object is left for the uploads/ expiry rule.
    expect(await env.BUCKET.head(`uploads/${id}.epub`)).not.toBeNull();
  });

  it("Lease claims a pending upload", async () => {
    const id = await pendingUpload(ao3Epub({ workId: freshAo3WorkId() }));
    const { handler } = watchedWorker(holding);

    const result = await deliver([{ upload_id: id }], { handler });

    const row = await uploadRow(id);
    expect(row.status).toBe("processing");
    expect(row.lease_until!.getTime()).toBeGreaterThan(Date.now());
    expect(result.explicitAcks).toEqual(["msg-0"]);
  });

  it("Duplicate delivery does not double-process", async () => {
    const id = await pendingUpload(ao3Epub({ workId: freshAo3WorkId() }));
    const leaseUntil = await setLease(id, "1 hour");
    const { handler, parsed } = watchedWorker();

    const result = await deliver([{ upload_id: id }], { handler });

    expect(parsed).toEqual([]);
    const row = await uploadRow(id);
    expect(row.status).toBe("processing");
    expect(row.lease_until).toEqual(leaseUntil);
    expect(row.error_stage).toBeNull();
    expect(result.explicitAcks).toEqual(["msg-0"]);
    expect(result.retryMessages).toEqual([]);
  });

  it("Expired lease can be re-claimed", async () => {
    const epub = ao3Epub({ workId: freshAo3WorkId() });
    const id = await pendingUpload(epub);
    await setLease(id, "-1 minute");
    const { handler, parsed } = watchedWorker(holding);

    const result = await deliver([{ upload_id: id }], { handler });

    expect(parsed).toEqual([epub]);
    const row = await uploadRow(id);
    expect(row.status).toBe("processing");
    expect(row.lease_until!.getTime()).toBeGreaterThan(Date.now());
    expect(result.explicitAcks).toEqual(["msg-0"]);
  });

  it("Concurrent deliveries claim the lease once", async () => {
    const id = await pendingUpload(ao3Epub({ workId: freshAo3WorkId() }));
    const first = watchedWorker(holding);
    const second = watchedWorker(holding);

    // Two invocations started at once, each with its own connection to Postgres; nothing
    // orders them, and the loser acks at its claim. The test database is one PGlite
    // session, so the two claims run one after the other: this shows one claim winning,
    // not a real Postgres's row lock and re-check under READ COMMITTED.
    const [firstResult, secondResult] = await Promise.all([
      deliver([{ upload_id: id }], { handler: first.handler }),
      deliver([{ upload_id: id }], { handler: second.handler }),
    ]);

    expect(first.parsed.length + second.parsed.length).toBe(1);
    expect((await uploadRow(id)).status).toBe("processing");
    expect(firstResult.explicitAcks).toEqual(["msg-0"]);
    expect(secondResult.explicitAcks).toEqual(["msg-0"]);
  });

  it("does not reclaim the lease of a job still running", async () => {
    const id = await pendingUpload(ao3Epub({ workId: freshAo3WorkId() }));
    const gate = gated();
    const first = watchedWorker({ ...holding, process: gate.process });
    const second = watchedWorker();

    // The first invocation is held inside its job while the second runs: the second neither
    // waits for it nor takes its live lease.
    const running = deliver([{ upload_id: id }], { handler: first.handler });
    await gate.entered;
    const secondResult = await deliver([{ upload_id: id }], { handler: second.handler });
    gate.release();
    const firstResult = await running;

    expect(first.parsed).toHaveLength(1);
    expect(second.parsed).toHaveLength(0);
    expect((await uploadRow(id)).status).toBe("processing");
    expect(firstResult.explicitAcks).toEqual(["msg-0"]);
    expect(secondResult.explicitAcks).toEqual(["msg-0"]);
  });

  it("Permanent failure goes to the dead-letter queue as parse_failed", async () => {
    const id = await pendingUpload(ao3Epub({ workId: freshAo3WorkId() }));
    const { handler } = watchedWorker({
      process: async () => {
        throw new TypeError("injected failure at the process stage");
      },
    });

    // The last delivery: max_retries (3) retries after the first.
    const result = await deliver([{ upload_id: id }], { attempts: 4, handler });

    const row = await uploadRow(id);
    expect(row.status).toBe("parse_failed");
    expect(row.error_stage).toBe("process");
    expect(row.error).toBe("TypeError");
    expect(row.lease_until).toBeNull();
    // Retried, not acked, so the queue moves it to its dead-letter queue (wrangler.jsonc).
    expect(result.retryMessages.map((m) => m.msgId)).toEqual(["msg-0"]);
    expect(result.explicitAcks).toEqual([]);
  });

  it("records the stage that failed for good", async () => {
    const id = await pendingUpload(ao3Epub({ workId: freshAo3WorkId() }));
    const { handler } = watchedWorker({
      save: async () => {
        throw new RangeError("injected failure at the save stage");
      },
    });

    await deliver([{ upload_id: id }], { attempts: 4, handler });

    const row = await uploadRow(id);
    expect(row.status).toBe("parse_failed");
    expect(row.error_stage).toBe("save");
    expect(row.error).toBe("RangeError");
  });

  it("logs a failure's class name, never its message", async () => {
    const id = await pendingUpload(ao3Epub({ workId: freshAo3WorkId() }));
    const { handler } = watchedWorker({
      process: async () => {
        throw new TypeError("text quoted from the file: marker-in-message");
      },
    });
    const lines: string[] = [];
    for (const level of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        lines.push(JSON.stringify(args));
      });
    }

    try {
      await deliver([{ upload_id: id }], { attempts: 4, handler });
    } finally {
      vi.restoreAllMocks();
    }

    const text = lines.join("\n");
    expect(text).toContain(id);
    expect(text).not.toContain("marker-in-message");
    expect((await uploadRow(id)).error).toBe("TypeError");
  });

  it("releases the lease and retries a failure with attempts left", async () => {
    const id = await pendingUpload(ao3Epub({ workId: freshAo3WorkId() }));
    const { handler } = watchedWorker({
      process: async () => {
        throw new Error("injected transient failure");
      },
    });

    const result = await deliver([{ upload_id: id }], { attempts: 3, handler });

    const row = await uploadRow(id);
    expect(row.status).toBe("pending");
    expect(row.lease_until).toBeNull();
    expect(row.error_stage).toBeNull();
    expect(result.retryMessages.map((m) => m.msgId)).toEqual(["msg-0"]);
    expect(result.explicitAcks).toEqual([]);
  });

  it("Consumer concurrency stays bounded under a flood", async () => {
    // The platform cap is max_concurrency in wrangler.jsonc (test/queue-config.node.test.ts).
    // Inside one invocation, a full batch runs one job at a time, and none fails for waiting.
    const ids = await Promise.all(
      Array.from({ length: 5 }, () => pendingUpload(ao3Epub({ workId: freshAo3WorkId() }))),
    );
    const gate = gated();
    const { handler } = watchedWorker({ process: gate.process });

    const running = deliver(
      ids.map((id) => ({ upload_id: id })),
      { handler },
    );
    await gate.entered;
    gate.release();
    const result = await running;

    expect(gate.counts.most).toBe(1);
    expect(result.explicitAcks.sort()).toEqual(["msg-0", "msg-1", "msg-2", "msg-3", "msg-4"]);
    expect(result.retryMessages).toEqual([]);
  });

  it("acks a message that names no upload, and runs the rest of its batch", async () => {
    const id = await pendingUpload(ao3Epub({ workId: freshAo3WorkId() }));

    const result = await deliver([{ upload: id }, "not an object", { upload_id: id }]);

    expect((await uploadRow(id)).status).toBe("live");
    expect(result.explicitAcks.sort()).toEqual(["msg-0", "msg-1", "msg-2"]);
  });

  it("records parse_failed at the read stage, without a retry, when the object is gone", async () => {
    // As for a message redriven after the 7-day expiry of uploads/ (#176).
    const id = await pendingUpload(null);

    const result = await deliver([{ upload_id: id }]);

    const row = await uploadRow(id);
    expect(row.status).toBe("parse_failed");
    expect(row.error_stage).toBe("read");
    expect(row.error).toBe("object_missing");
    expect(row.lease_until).toBeNull();
    expect(result.explicitAcks).toEqual(["msg-0"]);
    expect(result.retryMessages).toEqual([]);
  });
});
