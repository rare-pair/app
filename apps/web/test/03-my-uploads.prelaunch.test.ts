import { describe, expect, it } from "vitest";
import { fetchW } from "./helpers";

describe("03-upload-status: My uploads before launch", () => {
  it("My uploads is closed before launch", async () => {
    const res = await fetchW("/me/uploads");

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/");
  });
});
