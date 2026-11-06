import { describe, expect, it } from "vitest";
import { isCrossSiteSubresource } from "../src/index";

const request = (site: string, dest: string) =>
  new Headers({ "sec-fetch-site": site, "sec-fetch-dest": dest });

describe("24-crawler-and-agent-blocking", () => {
  it("Another site can't spend a reader's limits: what another site embeds", () => {
    for (const dest of ["image", "iframe", "frame", "script", "style", "object", "embed", "empty"]) {
      expect(isCrossSiteSubresource(request("cross-site", dest)), dest).toBe(true);
    }
  });

  it("Another site can't spend a reader's limits: a followed link", () => {
    expect(isCrossSiteSubresource(request("cross-site", "document"))).toBe(false);
  });

  it("A request from this site, or typed in, is no cross-site subresource", () => {
    for (const site of ["same-origin", "same-site", "none"]) {
      expect(isCrossSiteSubresource(request(site, "image")), site).toBe(false);
    }
  });

  it("A client that sends neither header, or no Sec-Fetch-Dest, is no cross-site subresource", () => {
    expect(isCrossSiteSubresource(new Headers())).toBe(false);
    expect(isCrossSiteSubresource(new Headers({ "sec-fetch-site": "cross-site" }))).toBe(false);
    expect(isCrossSiteSubresource(new Headers({ "sec-fetch-dest": "image" }))).toBe(false);
  });
});
