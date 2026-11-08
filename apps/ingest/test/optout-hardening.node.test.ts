import type { Database } from "@archive/db";
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type DatabaseConnection,
} from "kysely";
import { describe, expect, it } from "vitest";
import { checkedNames as checkedPseuds } from "@archive/db";
import { ListCheckRejected, onRejectList } from "../src/lists";
import { isDataErrorState, sqlState } from "../src/sql-state";
import { MAX_INT4, parseWorkId } from "../src/work-id";

describe("21 opt-out hardening: the work ID", () => {
  it.each([
    ["1", 1],
    ["2147483647", MAX_INT4],
    ["41500", 41500],
    ["0", null],
    ["007", null],
    ["2147483648", null],
    ["-1", null],
    ["1e3", null],
    [" 5", null],
    ["", null],
    ["12345678901", null],
  ])("parses %j as %j", (id, expected) => {
    expect(parseWorkId(id)).toBe(expected);
  });
});

describe("21 opt-out hardening: the pseuds the check reads", () => {
  const a = (pseud: string, user: string | null = null) => ({ pseud, user });

  it("Normalises, dedupes and drops blank and invisible-only pseuds", () => {
    expect(checkedPseuds([a("Moon Child"), a("moon​ child"), a("  "), a("​"), a("Sun")])).toEqual([
      "moon child",
      "sun",
    ]);
  });

  it("Skips the Anonymous placeholder, not a user called Anonymous", () => {
    expect(checkedPseuds([a("Anonymous")])).toEqual([]);
    expect(checkedPseuds([a("ANONYMOUS​"), a("Sun")])).toEqual(["sun"]);
    expect(checkedPseuds([a("Anonymous", "Anonymous")])).toEqual(["anonymous"]);
  });

  it("Reads each author's login beside the pseud printed for it", () => {
    // A PDF's link with no pseud in it: the byline shows the printed pseud, the list may hold the login.
    expect(checkedPseuds([a("Opted Pseud", "optedlogin"), a("Sun", " ")])).toEqual([
      "opted pseud",
      "optedlogin",
      "sun",
    ]);
  });
});

describe("21 opt-out hardening: SQLSTATE", () => {
  const withCode = (code: string) => Object.assign(new Error("x"), { code });

  it("reads a five-character code and nothing else", () => {
    expect(sqlState(withCode("22021"))).toBe("22021");
    expect(sqlState(withCode("ECONNRESET"))).toBeNull();
    expect(sqlState("22021")).toBeNull();
  });

  it("calls classes 21, 22, 23 and 54 the file's fault, and others not", () => {
    for (const state of ["21000", "22021", "23505", "54000"]) {
      expect(isDataErrorState(state)).toBe(true);
    }
    for (const state of ["08006", "40001", "57014", null]) {
      expect(isDataErrorState(state)).toBe(false);
    }
  });
});

/**
 * A database whose every query fails with an error carrying `code`, as pg's do. The one stub
 * at the connection: a lost connection can't be made to happen to the real database.
 */
function failingDb(code: string): Kysely<Database> {
  const connection: DatabaseConnection = {
    executeQuery: () => Promise.reject(Object.assign(new Error("boom"), { code })),
    streamQuery: () => {
      throw new Error("not used");
    },
  };
  class FailingDriver extends DummyDriver {
    override acquireConnection() {
      return Promise.resolve(connection);
    }
  }
  return new Kysely<Database>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new FailingDriver(),
      createIntrospector: (db) => new PostgresIntrospector(db),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
}

describe("21 opt-out hardening: a list that fails", () => {
  const work = {
    ao3WorkId: "41540",
    authors: [{ pseud: "Someone", user: null }],
  };

  it("A list that can't be read is thrown as it is, to be retried", async () => {
    const error = await onRejectList(failingDb("08006"), work).then(
      () => null,
      (caught: Error) => caught,
    );

    expect(error).toMatchObject({ code: "08006" });
    expect(error).not.toBeInstanceOf(ListCheckRejected);
  });

  it("A list that refuses the file's data is a fixed code, with no text from the file", async () => {
    const error = await onRejectList(failingDb("22021"), work).catch((caught: Error) => caught);

    expect(error).toBeInstanceOf(ListCheckRejected);
    expect(error).toMatchObject({ code: "optout_check_rejected_22021" });
  });
});
