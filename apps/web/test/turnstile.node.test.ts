import { describe, expect, it } from "vitest";
import { verifyTurnstile, type TurnstileCheck } from "../src/turnstile";

const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
// A throwaway secret that is none of Cloudflare's published test secrets, so the action is checked.
const SECRET = "test-only-turnstile-secret";
// Cloudflare's published test secrets (always passes, always fails, token already spent).
const CLOUDFLARE_TEST_SECRETS = [
  "1x0000000000000000000000000000000AA",
  "2x0000000000000000000000000000000AA",
  "3x0000000000000000000000000000000AA",
];
// Cloudflare's published dummy token.
const TOKEN = "XXXX.DUMMY.TOKEN.XXXX";

interface Call {
  url: string;
  method: string | undefined;
  body: URLSearchParams;
}

/** A stand-in for Cloudflare's siteverify: records each call and answers with `reply`. */
function siteverify(reply: (init: RequestInit) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetch = async (url: string, init: RequestInit) => {
    // SAFETY: the verifier always posts a URLSearchParams body.
    calls.push({ url, method: init.method, body: init.body as URLSearchParams });
    return reply(init);
  };
  return { calls, fetch };
}

/** A siteverify reply, including the malformed ones a test sends. */
interface Reply {
  success?: boolean | string;
  hostname?: string;
  action?: unknown;
  "error-codes"?: string[];
}

const answer = (body: Reply) => () => Response.json(body);
const check = (fetch: TurnstileCheck["fetch"]): TurnstileCheck => ({
  secret: SECRET,
  hostname: "rarepair.fans",
  action: "login",
  remoteIp: "192.0.2.1",
  fetch,
});

describe("19-surge-controls-and-quotas", () => {
  it("Turnstile guards login and signup", async () => {
    const failing = siteverify(
      answer({ success: false, "error-codes": ["invalid-input-response"] }),
    );
    expect(await verifyTurnstile("not-a-passing-token", check(failing.fetch))).toBe("failed");

    const missing = siteverify(
      answer({ success: true, hostname: "rarepair.fans", action: "login" }),
    );
    for (const token of [null, ""]) {
      expect(await verifyTurnstile(token, check(missing.fetch))).toBe("failed");
    }
    // A missing token fails without asking Cloudflare.
    expect(missing.calls).toEqual([]);
  });
});

describe("verifyTurnstile", () => {
  it("passes a token Cloudflare accepts for this host", async () => {
    const cf = siteverify(answer({ success: true, hostname: "rarepair.fans", action: "login" }));
    expect(await verifyTurnstile(TOKEN, check(cf.fetch))).toBe("passed");

    expect(cf.calls).toHaveLength(1);
    expect(cf.calls[0]!.url).toBe(SITEVERIFY);
    expect(cf.calls[0]!.method).toBe("POST");
    expect(Object.fromEntries(cf.calls[0]!.body)).toEqual({
      secret: SECRET,
      response: TOKEN,
      remoteip: "192.0.2.1",
    });
  });

  it("leaves out remoteip when the client address is unknown", async () => {
    const cf = siteverify(answer({ success: true, hostname: "rarepair.fans", action: "login" }));
    expect(await verifyTurnstile(TOKEN, { ...check(cf.fetch), remoteIp: null })).toBe("passed");
    expect(cf.calls[0]!.body.has("remoteip")).toBe(false);
  });

  it("fails a token solved on another host", async () => {
    const cf = siteverify(answer({ success: true, hostname: "evil.example", action: "login" }));
    expect(await verifyTurnstile(TOKEN, check(cf.fetch))).toBe("failed");
  });

  it("fails anything but success: true", async () => {
    for (const reply of [
      { success: "true", hostname: "rarepair.fans", action: "login" },
      { hostname: "rarepair.fans", action: "login" },
    ]) {
      const cf = siteverify(answer(reply));
      expect(await verifyTurnstile(TOKEN, check(cf.fetch))).toBe("failed");
    }
  });

  it("fails a token over 2048 characters without asking Cloudflare", async () => {
    const cf = siteverify(answer({ success: true, hostname: "rarepair.fans", action: "login" }));
    expect(await verifyTurnstile("x".repeat(2049), check(cf.fetch))).toBe("failed");
    expect(cf.calls).toEqual([]);
    // 2048 is still a token Cloudflare is asked about.
    expect(await verifyTurnstile("x".repeat(2048), check(cf.fetch))).toBe("passed");
  });

  it("is unavailable when siteverify doesn't answer in time", async () => {
    // Never answers, but gives up when the verifier's signal aborts.
    const stalled = siteverify(
      (init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    const result = await verifyTurnstile(TOKEN, { ...check(stalled.fetch), timeoutMs: 20 });
    expect(result).toBe("unavailable");
  });

  it("is unavailable when siteverify can't be reached or answers with an error", async () => {
    const down = siteverify(() => Promise.reject(new TypeError("network down")));
    expect(await verifyTurnstile(TOKEN, check(down.fetch))).toBe("unavailable");

    const erroring = siteverify(() => new Response("bad gateway", { status: 502 }));
    expect(await verifyTurnstile(TOKEN, check(erroring.fetch))).toBe("unavailable");

    const garbled = siteverify(() => new Response("<html>", { status: 200 }));
    expect(await verifyTurnstile(TOKEN, check(garbled.fetch))).toBe("unavailable");

    for (const body of ["null", "[]", '"ok"']) {
      const odd = siteverify(() => new Response(body, { status: 200 }));
      expect(await verifyTurnstile(TOKEN, check(odd.fetch))).toBe("unavailable");
    }
  });

  it("fails a token solved for another form's action", async () => {
    const cf = siteverify(answer({ success: true, hostname: "rarepair.fans", action: "waitlist" }));
    expect(await verifyTurnstile(TOKEN, check(cf.fetch))).toBe("failed");
  });

  it("fails a reply with no action, or one that isn't a string", async () => {
    for (const action of [undefined, null, 7, ["login"], { name: "login" }, "LOGIN", ""]) {
      const cf = siteverify(answer({ success: true, hostname: "rarepair.fans", action }));
      expect(await verifyTurnstile(TOKEN, check(cf.fetch))).toBe("failed");
    }
  });

  it("skips the action under Cloudflare's published test secrets", async () => {
    // Their dummy flow may report no action, or "test", whatever the widget set.
    for (const secret of CLOUDFLARE_TEST_SECRETS) {
      for (const action of [undefined, "test"]) {
        const cf = siteverify(answer({ success: true, hostname: "rarepair.fans", action }));
        expect(await verifyTurnstile(TOKEN, { ...check(cf.fetch), secret })).toBe("passed");
      }
    }
    // The host is still checked.
    const cf = siteverify(answer({ success: true, hostname: "evil.example" }));
    const [secret = ""] = CLOUDFLARE_TEST_SECRETS;
    expect(await verifyTurnstile(TOKEN, { ...check(cf.fetch), secret })).toBe("failed");
  });
});
