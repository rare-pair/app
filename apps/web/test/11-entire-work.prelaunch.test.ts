import { describe, expect, it } from "vitest";
import { fetchW } from "./helpers";

// Runs in the "prelaunch" project: wrangler.jsonc with PRELAUNCH turned on.

describe("entire work before launch", () => {
  it("The entire work is closed before launch", async () => {
    // Work 1 is never seeded: whether or not it exists, the page is redirected home.
    for (const method of ["GET", "HEAD"]) {
      const res = await fetchW("/works/1/full", { method });
      expect(res.status, method).toBe(302);
      expect(res.headers.get("location"), method).toBe("/");
      expect(res.headers.get("strict-transport-security"), method).toBe(
        "max-age=31536000; includeSubDomains",
      );
    }
  });
});
