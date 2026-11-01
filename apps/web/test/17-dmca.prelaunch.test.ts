import { describe, expect, it } from "vitest";
import { BASE, fetchW } from "./helpers";

// Before launch /dmca is closed, as /remove is: the coming-soon page answers for it.

describe("17-reports-and-dmca: DMCA before launch", () => {
  it("/dmca redirects to the coming-soon page, for the form and for a post", async () => {
    const get = await fetchW("/dmca");
    expect(get.status).toBe(302);
    expect(get.headers.get("location")).toBe("/");

    const post = await fetchW("/dmca", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: BASE,
        "sec-fetch-site": "same-origin",
      },
      body: "work=1",
    });
    expect(post.status).toBe(302);
    expect(post.headers.get("location")).toBe("/");
  });
});
