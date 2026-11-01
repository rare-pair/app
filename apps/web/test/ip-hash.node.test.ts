import { describe, expect, it } from "vitest";
import { ipHash } from "../src/ip-hash";

// Throwaway keys, not credentials.
const KEY = "test-only-ip-hash-key";
const OTHER_KEY = "another-test-only-ip-hash-key";

describe("ipHash", () => {
  it("is one lowercase hex SHA-256 that holds no part of the address", async () => {
    const hash = await ipHash(KEY, "192.0.2.17");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain("192.0.2.17");
  });

  it("is the same for the same address and differs for another", async () => {
    const hash = await ipHash(KEY, "192.0.2.17");
    expect(await ipHash(KEY, "192.0.2.17")).toBe(hash);
    expect(await ipHash(KEY, "192.0.2.18")).not.toBe(hash);
  });

  it("is keyed: another key gives another hash for the same address", async () => {
    expect(await ipHash(OTHER_KEY, "192.0.2.17")).not.toBe(await ipHash(KEY, "192.0.2.17"));
  });

  it("hashes an IPv6 address by its /64", async () => {
    const hash = await ipHash(KEY, "2001:db8:1:2::1");
    expect(await ipHash(KEY, "2001:0db8:0001:0002:ffff:ffff:ffff:9")).toBe(hash);
    expect(await ipHash(KEY, "2001:db8:1:3::1")).not.toBe(hash);
  });

  it("hashes an IPv4 address written as IPv6 as the IPv4 address", async () => {
    expect(await ipHash(KEY, "::ffff:192.0.2.17")).toBe(await ipHash(KEY, "192.0.2.17"));
  });

  it("hashes a missing or empty address as one fixed marker", async () => {
    const none = await ipHash(KEY, null);
    expect(await ipHash(KEY, "")).toBe(none);
    expect(none).toMatch(/^[0-9a-f]{64}$/);
    expect(none).not.toBe(await ipHash(KEY, "192.0.2.17"));
    expect(none).not.toBe(await ipHash(KEY, "unknown"));
  });
});
