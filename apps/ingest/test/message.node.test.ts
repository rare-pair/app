import { describe, expect, it } from "vitest";
import { parseBackfillMessage, parseMessage } from "../src/message";

describe("ingest message contract", () => {
  it("takes an upload id of 1 to 64 characters", () => {
    expect(parseMessage({ upload_id: "a" })).toEqual({ upload_id: "a" });
    expect(parseMessage({ upload_id: "x".repeat(64) })).toEqual({ upload_id: "x".repeat(64) });
  });

  it("refuses a body that names no upload", () => {
    expect(parseMessage({ upload_id: "" })).toBeNull();
    expect(parseMessage({ upload_id: "x".repeat(65) })).toBeNull();
    expect(parseMessage({ upload_id: 7 })).toBeNull();
    expect(parseMessage({ uploadId: "a" })).toBeNull();
    expect(parseMessage(null)).toBeNull();
    expect(parseMessage("a")).toBeNull();
  });
});

describe("backfill message contract", () => {
  it("takes a work id and a version id of 1 to 64 characters each", () => {
    expect(parseBackfillMessage({ work_id: "w", version_id: "v" })).toEqual({
      work_id: "w",
      version_id: "v",
    });
    const long = { work_id: "w".repeat(64), version_id: "v".repeat(64) };
    expect(parseBackfillMessage(long)).toEqual(long);
  });

  it("refuses a body that names no work or no version", () => {
    expect(parseBackfillMessage({ work_id: "w" })).toBeNull();
    expect(parseBackfillMessage({ version_id: "v" })).toBeNull();
    expect(parseBackfillMessage({ work_id: "", version_id: "v" })).toBeNull();
    expect(parseBackfillMessage({ work_id: "w", version_id: "v".repeat(65) })).toBeNull();
    expect(parseBackfillMessage({ work_id: 7, version_id: "v" })).toBeNull();
    expect(parseBackfillMessage({ upload_id: "u" })).toBeNull();
    expect(parseBackfillMessage(null)).toBeNull();
    expect(parseBackfillMessage("w")).toBeNull();
  });
});
