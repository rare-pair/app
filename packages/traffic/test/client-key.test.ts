import { describe, expect, it } from "vitest";
import { clientOf, ipKey } from "../src/index";

/** The sign-in limit's key for a client address, or for a request without one. */
const loginIp = (address: string | null) => ipKey("login", address);

describe("ipKey", () => {
  it("keeps the keys the limiters already count under", async () => {
    // sha256sum of "login-ip:192.0.2.1", "login-ip:2001:0db8:0001:0002::/64", "login-ip:unknown".
    expect(await loginIp("192.0.2.1")).toBe(
      "10044d4388373f4ca90efb7f6dac17e85a2702dfddbb9ff276566f95069dfd18",
    );
    expect(await loginIp("2001:db8:1:2::1")).toBe(
      "9543f533eb1b0a8706b0d0d8fa892e8b39c8c38bfda7e21fbb673c733159820b",
    );
    expect(await loginIp(null)).toBe(
      "fecdbe96faf25d109c5a7fb2539c35551683c8a4697dfb1fe3718fadf2b53545",
    );
  });

  it("keys an IPv4 client on its whole address", async () => {
    const key = await loginIp("192.0.2.1");
    expect(await loginIp("192.0.2.1")).toBe(key);
    expect(await loginIp("192.0.2.2")).not.toBe(key);
  });

  it("keys an IPv6 client on its /64, which one subscriber commonly holds", async () => {
    const key = await loginIp("2001:db8:1:2::1");
    expect(await loginIp("2001:db8:1:2:ffff:ffff:ffff:9")).toBe(key);
    expect(await loginIp("2001:0db8:0001:0002:0000:0000:0000:0042")).toBe(key);
    expect(await loginIp("2001:DB8:1:2::abcd")).toBe(key);
    expect(await loginIp("2001:db8:1:3::1")).not.toBe(key);
    // The /64 is the first four groups however the address is shortened.
    expect(await loginIp("2001:db8::1")).toBe(await loginIp("2001:db8:0:0::2"));
    expect(await loginIp("::1")).toBe(await loginIp("::2"));
  });

  it("keys an IPv4 address written as IPv6 on the IPv4 address", async () => {
    const key = await loginIp("198.51.100.7");
    expect(await loginIp("::ffff:198.51.100.7")).toBe(key);
    expect(await loginIp("::FFFF:198.51.100.7")).toBe(key);
    // In hex too: c633:6407 is 198.51.100.7.
    expect(await loginIp("::ffff:c633:6407")).toBe(key);
    expect(await loginIp("0:0:0:0:0:ffff:c633:6407")).toBe(key);
    const other = await loginIp("::ffff:203.0.113.9");
    expect(other).not.toBe(key);
    expect(other).not.toBe(await loginIp("::1"));
  });

  it("keys any other IPv6 address with a dotted tail on its /64", async () => {
    const key = await loginIp("2001:db8:1:2::c000:201");
    expect(await loginIp("2001:db8:1:2::192.0.2.1")).toBe(key);
    expect(await loginIp("2001:DB8:1:2::192.0.2.9")).toBe(key);
    expect(await loginIp("2001:db8:9:9::192.0.2.1")).not.toBe(key);
    expect(await loginIp("2001:db8:1:2::192.0.2.1")).not.toBe(await loginIp("192.0.2.1"));
    // With six groups before the tail, or a "::" that stands for just one.
    const full = await loginIp("1:2:3:4:5:6:102:304");
    expect(await loginIp("1:2:3:4:5:6:1.2.3.4")).toBe(full);
    expect(await loginIp("1:2:3:4:5::1.2.3.4")).toBe(full);
  });

  it("keys a value that isn't an address as itself, never as some real address", async () => {
    for (const [bad, lookalike] of [
      ["::ffff:1.2.3", "1.2.3.0"],
      ["::ffff:1.2.3.4.5", "1.2.3.4"],
      ["::ffff:256.0.0.1", "0.0.0.1"],
      ["::ffff:1.256.0.0", "1.0.0.0"],
      ["::ffff:0x7f.0.0.1", "127.0.0.1"],
      ["::ffff:1.2.3.4%eth0", "1.2.3.0"],
      ["::ffff:a.b.c.d", "0.0.0.0"],
      ["1:2:3:4:5:6:7:1.2.3.4", "1:2:3:4::1"],
      ["1::2::3", "1::3"],
    ] as const) {
      expect(await loginIp(bad)).not.toBe(await loginIp(lookalike));
    }
    // Nor do they share one key among themselves, or with requests that have no address.
    const bad = ["::ffff:1.2.3", "::ffff:256.0.0.1", "1::2::3"];
    const keys = await Promise.all([...bad.map(loginIp), loginIp(null)]);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("gives every request without a client address one shared key, still limited", async () => {
    const key = await loginIp(null);
    expect(await loginIp(null)).toBe(key);
    // An empty header is no address either.
    expect(await loginIp("")).toBe(key);
    expect(key).not.toBe(await loginIp("192.0.2.1"));
  });

  it("never carries the address itself, and differs between limits", async () => {
    const key = await loginIp("192.0.2.1");
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(key).not.toContain("192.0.2.1");
    expect(await ipKey("search", "192.0.2.1")).not.toBe(key);
  });
});

describe("clientOf", () => {
  it("names who an address stands for", () => {
    expect(clientOf("192.0.2.1")).toBe("192.0.2.1");
    expect(clientOf("2001:db8:1:2::1")).toBe("2001:0db8:0001:0002::/64");
    expect(clientOf("::ffff:198.51.100.7")).toBe("198.51.100.7");
    expect(clientOf("nonsense")).toBe("not an address: nonsense");
  });
});
