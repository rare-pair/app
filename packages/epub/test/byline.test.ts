import { describe, expect, it } from "vitest";
import { BYLINE_AMBIGUOUS, BYLINE_MISSING, processEpub } from "../src";
import { ao3Epub } from "./helpers";

// Synthetic epubs only: structure, no fanwork text. The byline is the opt-out check's input
// (ARCHITECTURE, EPUB processor step 4), so every case here is about who gets checked.

const link = (name: string, text = name) =>
  `<a href="http://archiveofourown.org/users/${name}/pseuds/${name}" rel="author">${text}</a>`;

const pseuds = async (spec: Parameters<typeof ao3Epub>[0]) =>
  (await processEpub(ao3Epub(spec))).authors.map((a) => a.pseud);

describe("Byline hardening (#258, #276)", () => {
  it("A blank preface byline falls back to the OPF creators, in order", async () => {
    for (const blank of [" ", "&#x200B;", "&#x2060;", "&#xA0;&#x200B;"]) {
      const work = await processEpub(
        ao3Epub({
          bylineHtml: link("ghost", blank),
          creators: ["First", "Second"],
        }),
      );
      expect(work.authors).toEqual([
        { pseud: "First", user: null },
        { pseud: "Second", user: null },
      ]);
      expect(work.reviewReasons).not.toContain(BYLINE_MISSING);
    }
  });

  it("A blank link beside a real one never reaches authors", async () => {
    const work = await processEpub(
      ao3Epub({
        bylineHtml: `${link("real")}, ${link("ghost", "&#x200B;")}`,
        creators: ["real"],
      }),
    );
    expect(work.authors).toEqual([{ pseud: "real", user: "real" }]);
  });

  it("A real byline keeps its profile user and the same OPF creator adds nothing", async () => {
    const work = await processEpub(ao3Epub({ pseud: "someone" }));
    expect(work.authors).toEqual([{ pseud: "someone", user: "someone" }]);
    expect(work.reviewReasons).toEqual([]);
  });

  it("An OPF creator the byline lacks joins the authors", async () => {
    expect(await pseuds({ bylineHtml: link("real"), creators: ["real", "Other"] })).toEqual([
      "real",
      "Other",
    ]);
  });

  it("An OPF creator equal to a byline pseud after normalising is not added again", async () => {
    expect(
      await pseuds({
        bylineHtml: link("moonchild", "Moon&#x200B;Child"),
        creators: ["MOONCHILD"],
      }),
    ).toEqual(["Moon​Child"]);
  });

  it("A byline with no name and no creator is flagged byline_missing", async () => {
    for (const bylineHtml of [link("ghost", " "), link("ghost", "&#x200B;"), ""]) {
      const work = await processEpub(ao3Epub({ bylineHtml, creators: [] }));
      expect(work.authors).toEqual([]);
      expect(work.reviewReasons).toContain(BYLINE_MISSING);
    }
  });

  it("Blank OPF creators count as none", async () => {
    const work = await processEpub(
      ao3Epub({ bylineHtml: link("ghost", " "), creators: ["&#x200B;", " "] }),
    );
    expect(work.authors).toEqual([]);
    expect(work.reviewReasons).toContain(BYLINE_MISSING);
  });

  it("A no-link byline split into several names is flagged byline_ambiguous", async () => {
    for (const [bylineHtml, names] of [
      ["Salt and Pepper", ["Salt", "Pepper"]],
      ["Salt, Pepper", ["Salt", "Pepper"]],
    ] as const) {
      const work = await processEpub(ao3Epub({ bylineHtml, creators: [] }));
      expect(work.authors.map((a) => a.pseud)).toEqual(names);
      expect(work.reviewReasons).toContain(BYLINE_AMBIGUOUS);
      expect(work.reviewReasons).not.toContain(BYLINE_MISSING);
    }
  });

  it("A one-name no-link byline is not flagged", async () => {
    const work = await processEpub(ao3Epub({ bylineHtml: "Anonymous", creators: ["Anonymous"] }));
    expect(work.authors).toEqual([{ pseud: "Anonymous", user: null }]);
    expect(work.reviewReasons).toEqual([]);
  });

  it("A byline of profile links is not flagged, whatever the pseuds contain", async () => {
    const work = await processEpub(
      ao3Epub({
        bylineHtml: link("saltpepper", "Salt and Pepper"),
        creators: ["Salt and Pepper"],
      }),
    );
    expect(work.authors).toEqual([{ pseud: "Salt and Pepper", user: "saltpepper" }]);
    expect(work.reviewReasons).toEqual([]);
  });

  it("One OPF creator holding several names is flagged and each name is checked", async () => {
    const work = await processEpub(
      ao3Epub({
        bylineHtml: link("ghost", " "),
        creators: ["Salt and Pepper"],
      }),
    );
    expect(work.authors.map((a) => a.pseud)).toEqual(["Salt and Pepper", "Salt", "Pepper"]);
    expect(work.reviewReasons).toContain(BYLINE_AMBIGUOUS);
  });

  it("An OPF creator whose every name the byline links adds nothing and is not flagged", async () => {
    const work = await processEpub(
      ao3Epub({ bylineHtml: `${link("alice")}, ${link("bob")}`, creators: ["alice and bob"] }),
    );
    expect(work.authors.map((a) => a.pseud)).toEqual(["alice", "bob"]);
    expect(work.reviewReasons).toEqual([]);
  });

  it("An Oxford comma and a stray separator cut no name wrongly", async () => {
    const oxford = await processEpub(ao3Epub({ bylineHtml: "Q, and P", creators: [] }));
    expect(oxford.authors.map((a) => a.pseud)).toEqual(["Q", "P"]);
    const stray = await processEpub(ao3Epub({ bylineHtml: link("ghost", " "), creators: ["P,"] }));
    expect(stray.authors.map((a) => a.pseud)).toEqual(["P,", "P"]);
  });

  it("The review codes carry no byline text", async () => {
    const work = await processEpub(ao3Epub({ bylineHtml: "Salt and Pepper", creators: [] }));
    expect(work.reviewReasons.join(" ")).not.toMatch(/salt|pepper/i);
  });
});
