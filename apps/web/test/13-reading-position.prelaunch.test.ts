import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { fetchW } from "./helpers";

// Before launch the position save is closed, like the reader that calls it.
describe("13-reader-settings-and-position, before launch", () => {
  it("The position save is closed before launch", async () => {
    const res = await fetchW("/works/24001/position", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: "https://rarepair.fans",
        "sec-fetch-site": "same-origin",
      },
      body: "n=1&pct=10",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/");
    expect((await env.POSITIONS.list({ prefix: "pos:" })).keys).toEqual([]);
  });
});
