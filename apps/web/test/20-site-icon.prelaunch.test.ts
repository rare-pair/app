import { describe, expect, it } from "vitest";
import { fetchW } from "./helpers";

// Before launch the coming-soon page and the icon it declares are open to a signed-out visitor.

describe("20-site-chrome-and-legal: before launch", () => {
  it("The tab shows the star", async () => {
    for (const path of ["/", "/about"]) {
      const html = await (await fetchW(path)).text();
      const href = html.match(/<link rel="icon" type="image\/svg\+xml" href="([^"]+)"/)?.[1];
      expect(href, path).toMatch(/^\/assets\/logo\.[0-9a-f]+\.svg$/);
      const res = await fetchW(href ?? "");
      expect(res.status, path).toBe(200);
      expect(res.headers.get("location")).toBeNull();
      expect(res.headers.get("content-type"), path).toBe("image/svg+xml");
      expect(res.headers.get("set-cookie")).toBeNull();
    }
  });
});
