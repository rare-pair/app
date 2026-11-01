import { Script } from "node:vm";
import { describe, expect, it } from "vitest";
import {
  continueHref,
  parsePosition,
  POSITION_SCRIPT,
  positionKey,
  serializePosition,
} from "../src/position";

// The pure parts of the saved reading position: key, value and link. Numbers only.

describe("positionKey", () => {
  it("joins the user and the AO3 work ID under pos:", () => {
    expect(positionKey("u-1", 12345)).toBe("pos:u-1:12345");
  });
});

describe("parsePosition", () => {
  it("reads what serializePosition wrote, a chapter or the whole work", () => {
    expect(parsePosition(serializePosition({ n: 3, pct: 42 }))).toEqual({ n: 3, pct: 42 });
    expect(parsePosition(serializePosition({ n: null, pct: 0 }))).toEqual({ n: null, pct: 0 });
  });

  it("is null for anything that is not a position", () => {
    for (const raw of [
      null,
      "",
      "not json",
      "null",
      "[]",
      "7",
      '{"n":"3","pct":1}',
      '{"n":3}',
      '{"n":3,"pct":101}',
      '{"n":3,"pct":-1}',
      '{"n":3,"pct":1.5}',
      '{"n":0,"pct":1}',
      '{"n":2147483648,"pct":1}',
      '{"n":3,"pct":1,"extra":"<script>"}',
    ]) {
      expect(parsePosition(raw), String(raw)).toBeNull();
    }
  });
});

describe("POSITION_SCRIPT", () => {
  it("is syntactically valid script text", () => {
    // Compiled, never called: there is no DOM here to run it against.
    expect(() => new Script(POSITION_SCRIPT)).not.toThrow();
  });
});

describe("continueHref", () => {
  it("names the chapter in the path and the percentage in a fragment", () => {
    expect(continueHref(77, { n: 3, pct: 42 })).toBe("/works/77/chapters/3#pos=42");
  });

  it("goes to the entire work page when no chapter was saved", () => {
    expect(continueHref(77, { n: null, pct: 9 })).toBe("/works/77/full#pos=9");
  });
});
