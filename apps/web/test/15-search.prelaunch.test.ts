import { describe, expect, it } from "vitest";
import { fetchW } from "./helpers";

describe("15-search before launch", () => {
  it("Search is closed before launch", async () => {
    const res = await fetchW("/search?q=anything");

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/");
  });
});
