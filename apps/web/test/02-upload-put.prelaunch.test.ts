import { describe, expect, it } from "vitest";
import { BASE, fetchW } from "./helpers";

describe("02-upload-handshake before launch", () => {
  it.each(["PUT", "DELETE"])("%s /uploads/:id goes to the coming-soon page", async (method) => {
    const res = await fetchW(`/uploads/${crypto.randomUUID()}`, {
      method,
      headers: { origin: BASE, "sec-fetch-site": "same-origin" },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/");
  });
});
