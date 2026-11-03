import { processEpub } from "@archive/epub";
import { describe, expect, it } from "vitest";
import { ao3Epub } from "../../../packages/epub/test/helpers";
import {
  addOptOut,
  addTakedown,
  deliver,
  expectNotOptedOut,
  expectOptedOut,
  freshAo3WorkId,
  ingestEpub,
  ingestParsed,
  ingestReal,
  ingestUpload,
  parsedWork,
  pendingUpload,
  seededWork,
  token,
  uploadRow,
  versionsOf,
  watchedWorker,
  workExists,
} from "./helpers";

// AO3 work ids 41500-41599 are this file's; every other upload takes a `freshAo3WorkId`. Each
// case opts out a pseud of its own, with a token, as file 16 does: an opt-out stays in the
// database every test file shares. Synthetic text only.

const link = (name: string, text = name) =>
  `<a href="http://archiveofourown.org/users/${name}/pseuds/${name}" rel="author">${text}</a>`;

/** An epub of `workId` whose byline is `bylineHtml` and whose OPF names `creators`. */
const withByline = (workId: number, bylineHtml: string, creators: string[]) =>
  ao3Epub({ workId, bylineHtml, creators });

/** A job whose processor answers with a byline of `pseuds` (too many to spread), and a stub save. */
async function ingestByline(pseuds: string[]) {
  const id = await pendingUpload(ao3Epub({ workId: freshAo3WorkId() }));
  const saved: string[] = [];
  const { handler } = watchedWorker({
    process: async (bytes) => ({
      ...(await processEpub(bytes)),
      authors: pseuds.map((pseud) => ({ pseud, user: null })),
    }),
    save: async (upload) => void saved.push(upload.id),
  });
  const result = await deliver([{ upload_id: id }], { handler });
  return { id, row: await uploadRow(id), saved, result };
}

describe("21-opt-out-hardening: a blank preface byline", () => {
  it("checks the OPF creator when every preface pseud is blank", async () => {
    const t = token();
    await addOptOut(`ghost${t}`);
    const workId = 41500;

    for (const blank of [" ", "&#x200B;"]) {
      const epub = withByline(workId, link("x", blank), [`Ghost${t}`]);
      expectOptedOut(await ingestUpload(epub));
    }
    expect(await workExists(workId)).toBe(false);
  });

  it("checks an OPF creator the preface byline doesn't name", async () => {
    const t = token();
    await addOptOut(`ghost${t}`);

    const epub = withByline(41501, link("real"), ["real", `Ghost${t}`]);
    expectOptedOut(await ingestUpload(epub));
  });

  it("checks each name of a byline with no profile links", async () => {
    const t = token();
    await addOptOut(`pepper${t}`);

    const epub = withByline(41502, `Salt${t} and Pepper${t}`, []);
    expectOptedOut(await ingestUpload(epub));
  });

  it("checks each name of one OPF creator that holds several", async () => {
    const t = token();
    await addOptOut(`pepper${t}`);

    const epub = withByline(41503, link("x", " "), [`Salt${t}, Pepper${t}`]);
    expectOptedOut(await ingestUpload(epub));
  });
});

describe("21-opt-out-hardening: an empty or ambiguous byline goes live, flagged", () => {
  it("An empty byline goes live with byline_missing", async () => {
    const workId = 41510;
    const { row } = await ingestReal(withByline(workId, link("x", " "), []));

    expect(row.status).toBe("live");
    const { versions, status } = await versionsOf(workId);
    expect(status).toBe("live");
    expect(versions).toHaveLength(1);
    expect(versions[0]?.review_reasons).toEqual(["byline_missing"]);
    expect(versions[0]?.hold_reason).toBeNull();
  });

  it("A byline that can only be split ambiguously goes live with byline_ambiguous", async () => {
    const workId = 41511;
    const { row } = await ingestReal(withByline(workId, "Salt and Pepper", []));

    expect(row.status).toBe("live");
    const { versions } = await versionsOf(workId);
    expect(versions[0]?.review_reasons).toEqual(["byline_ambiguous"]);
    expect(versions[0]?.authors).toEqual([
      { pseud: "Salt", user: null },
      { pseud: "Pepper", user: null },
    ]);
  });

  it("A one-name byline and a byline of profile links carry no byline code", async () => {
    const one = await ingestReal(withByline(41512, "Anonymous", ["Anonymous"]));
    const links = await ingestReal(
      withByline(41513, `${link("a")}, ${link("b", "Salt and Pepper")}`, ["a", "Salt and Pepper"]),
    );

    expect(one.row.status).toBe("live");
    expect(links.row.status).toBe("live");
    expect((await versionsOf(41512)).versions[0]?.review_reasons).toEqual([]);
    expect((await versionsOf(41513)).versions[0]?.review_reasons).toEqual([]);
  });

  it("An update with an ambiguous byline goes live, flagged", async () => {
    const workId = 41514;
    const byline = (stats: string) =>
      ao3Epub({ workId, stats, bylineHtml: "Salt and Pepper", creators: [] });
    await ingestReal(byline("Published: 2020-01-02 Words: 12"));

    const { row } = await ingestReal(byline("Published: 2020-01-02 Updated: 2020-02-02 Words: 12"));

    expect(row.status).toBe("live");
    const { versions, current } = await versionsOf(workId);
    expect(versions).toHaveLength(2);
    expect(versions.find((v) => v.id === current)?.review_reasons).toEqual(["byline_ambiguous"]);
  });

  it("An opted-out ambiguous byline is refused, not saved", async () => {
    const t = token();
    await addOptOut(`pepper${t}`);

    expectOptedOut(await ingestUpload(withByline(41515, `Salt${t} and Pepper${t}`, [])));
    expect(await workExists(41515)).toBe(false);
  });
});

describe("21-opt-out-hardening: a hostile value in the file", () => {
  it("A byline of 70,000 pseuds is checked in one query", async () => {
    const t = token();
    await addOptOut(`last${t}`);
    // A real file can't carry this many: the processor's node budget stops it first.
    const crowd = Array.from({ length: 70_000 }, (_, i) => `crowd ${t} ${i}`);

    expectOptedOut(await ingestByline([...crowd, `Last${t}`]));
    expectNotOptedOut(await ingestByline(crowd));
  });

  it.each([
    ["0", "a zero"],
    ["2147483648", "past an int4"],
  ])("An AO3 work ID of %s (%s) ends parse_failed with bad_work_id", async (id) => {
    const { row } = await ingestParsed(parsedWork({ ao3WorkId: id }));

    expect(row.status).toBe("parse_failed");
    expect(row.error_stage).toBe("save");
    expect(row.error).toBe("bad_work_id");
  });

  it("An AO3 work ID with a leading zero is not the work it spells", async () => {
    // Read as a number, "041520" is work 41520, whose takedown would block a different file.
    const seeded = await seededWork({ ao3WorkId: 41520, status: "removed" });
    await addTakedown(seeded.workId, "removed");

    const { row } = await ingestParsed(parsedWork({ ao3WorkId: "041520" }));

    expect(row.status).toBe("parse_failed");
    expect(row.error).toBe("bad_work_id");
  });

  it("A takedown of the work with that exact ID still blocks it", async () => {
    const seeded = await seededWork({ ao3WorkId: 41521, status: "removed" });
    await addTakedown(seeded.workId, "removed");

    expectOptedOut(await ingestEpub(41521));
  });
});
