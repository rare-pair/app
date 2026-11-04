import { describe, expect, it } from "vitest";
import { fetchW } from "./helpers";

// Before launch the settings page is closed, like the reader it serves.
describe("13-reader-settings-and-position, before launch", () => {
  it("The settings form is closed before launch", async () => {
    const page = await fetchW("/settings/reader");
    expect(page.status).toBe(302);
    expect(page.headers.get("location")).toBe("/");
    const post = await fetchW("/settings/reader", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: "https://rarepair.fans",
        "sec-fetch-site": "same-origin",
      },
      body: "theme=dark&next=/",
    });
    expect(post.status).toBe(302);
    expect(post.headers.get("location")).toBe("/");
    expect(post.headers.getSetCookie()).toEqual([]);
  });
});
