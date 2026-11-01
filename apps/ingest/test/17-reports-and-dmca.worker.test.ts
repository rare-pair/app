import { describe, it } from "vitest";
import { TAKEDOWN_REMOVED } from "../src/lists";
import { addTakedown, expectNotOptedOut, expectOptedOut, ingestEpub, seededWork } from "./helpers";

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

  it("finds a takedown on AO3 work ID 0", async () => {
    // The schema allows 0, so it can be listed like any ID. The only test seeding 0.
    const seeded = await seededWork({ ao3WorkId: 0, status: "removed" });
    await addTakedown(seeded.workId, TAKEDOWN_REMOVED);

    expectOptedOut(await ingestEpub(0));
  });

  it("finds no takedown for an AO3 work ID past int4", async () => {
    // No work can have it, so it is on no list, and Postgres is never asked about it.
    expectNotOptedOut(await ingestEpub(2_147_483_648));
  });
});
