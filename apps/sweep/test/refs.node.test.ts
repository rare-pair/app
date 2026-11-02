import { describe, expect, it } from "vitest";
import { imageRefs } from "../src/refs";

// What counts as a version referencing an image: its path in the stored HTML.

const A = "a".repeat(64);
const B = "0123456789abcdef".repeat(4);

describe("sweep image references", () => {
  it("An img src under the work's img prefix is a reference", () => {
    const html = `<p><img src="https://content.rarepair.fans/works/42/img/${A}" alt=""></p>`;
    expect(imageRefs(html, 42)).toEqual(new Set([A]));
  });

  it("A reference counts whatever origin it is served from", () => {
    const html = `<img src="https://elsewhere.example/works/42/img/${A}"><img src="/works/42/img/${B}">`;
    expect(imageRefs(html, 42)).toEqual(new Set([A, B]));
  });

  it("Another work's image is not a reference", () => {
    const html = `<img src="/works/421/img/${A}"><img src="/works/4/img/${B}">`;
    expect(imageRefs(html, 42)).toEqual(new Set());
  });

  it("A key that is not 64 lowercase hex is not a reference", () => {
    const html = [
      `<img src="/works/42/img/${A.toUpperCase()}">`,
      `<img src="/works/42/img/${"g".repeat(64)}">`,
      `<img src="/works/42/img/${"a".repeat(63)}">`,
      `<img src="/works/42/img/${"a".repeat(65)}">`,
    ].join("");
    expect(imageRefs(html, 42)).toEqual(new Set());
  });
});
