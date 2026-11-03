import { describe, expect, it } from "vitest";
import { TAKEDOWN_REMOVED } from "../src/lists";
import {
  addTakedown,
  expectNotOptedOut,
  expectOptedOut,
  ingestEpub,
  ingestParsed,
  parsedWork,
  seededWork,
} from "./helpers";

// Each case seeds a work with an AO3 work ID of its own: a takedown stays in the database every
// test file shares. The scenario's 12345 stands for any ID.

/** A work with a DMCA notice in `notice` status, then a new upload of it, ingested. */
async function reuploadAfterNotice(work: "live" | "removed", notice: string) {
  const seeded = await seededWork({ status: work });
  await addTakedown(seeded.workId, notice);
  return ingestEpub(seeded.ao3WorkId);
}

describe("17-reports-and-dmca", () => {
  it("Taken-down work cannot be re-uploaded", async () => {
    expectOptedOut(await reuploadAfterNotice("removed", TAKEDOWN_REMOVED));
  });

  it("Pending DMCA notice does not block an upload", async () => {
    // Passed on to the save step, where the versioning rules apply.
    expectNotOptedOut(await reuploadAfterNotice("live", "pending"));
  });

  it("does not block a removed work whose notice no moderator acted on", async () => {
    // Removed for another reason: only a notice that removed the work lists it.
    expectNotOptedOut(await reuploadAfterNotice("removed", "pending"));
  });

  it("does not block a work restored after its takedown", async () => {
    // The list holds removed works: a moderator who restores one takes it off.
    expectNotOptedOut(await reuploadAfterNotice("live", TAKEDOWN_REMOVED));
  });

  it("checks no takedown for AO3 work ID 0, which the save refuses", async () => {
    // The schema allows 0, but no file can have it: the job and the save read an ID through
    // one parser, so 0 is `bad_work_id` whatever the list holds (it was `opted_out` before
    // #275). Either way no work is saved. The only test seeding 0.
    const seeded = await seededWork({ ao3WorkId: 0, status: "removed" });
    await addTakedown(seeded.workId, TAKEDOWN_REMOVED);

    const { row } = await ingestParsed(parsedWork({ ao3WorkId: "0" }));

    expect(row.status).toBe("parse_failed");
    expect(row.error).toBe("bad_work_id");
  });

  it("finds no takedown for an AO3 work ID past int4", async () => {
    // No work can have it, so it is on no list, and Postgres is never asked about it.
    expectNotOptedOut(await ingestEpub(2_147_483_648));
  });
});
