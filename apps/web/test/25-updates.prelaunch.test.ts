import { describe, expect, it } from "vitest";
import { fetchW } from "./helpers";

// Runs in the "prelaunch" project: wrangler.jsonc as deployed, with PRELAUNCH on.
describe("25-updates before launch", () => {
  it("Closed before launch", async () => {
    const res = await fetchW("/updates/release-0-1-0-chuhura");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/");

    const home = await fetchW("/");
    expect(home.status).toBe(200);
    const html = await home.text();
    expect(html).not.toContain("Updates</h2>");
    expect(html).not.toContain("/updates/");
  });
});
