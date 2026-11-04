import { describe, expect, it } from "vitest";
import { resendSender } from "../src/resend";
import type { OutgoingEmail } from "../src/sender";

const email: OutgoingEmail = {
  from: "rarepair <sign-in@mail.example.test>",
  to: "reader@example.test",
  subject: "Your sign-in link for rarepair",
  text: "https://rarepair.fans/login/confirm?token=link-1",
};

const answering =
  (res: () => Response): typeof fetch =>
  async () =>
    res();

describe("Resend batch sender", () => {
  it("posts the emails as one JSON array with the API key", async () => {
    let seen: { url: string; init?: RequestInit } | undefined;
    const fetcher: typeof fetch = async (input, init) => {
      // SAFETY: the sender passes its URL as a string; anything else fails the URL check below.
      seen = { url: input as string, init };
      return Response.json({ data: [{ id: "resend-1" }] });
    };

    const result = await resendSender("re_test_key", fetcher).sendBatch([email]);

    expect(result).toEqual({ outcome: "sent", ids: ["resend-1"] });
    expect(seen?.url).toBe("https://api.resend.com/emails/batch");
    expect(seen?.init?.method).toBe("POST");
    expect(new Headers(seen?.init?.headers).get("authorization")).toBe("Bearer re_test_key");
    // SAFETY: the sender posts its batch as a JSON string.
    expect(JSON.parse(seen?.init?.body as string)).toEqual([email]);
  });

  // Rate limit, quota or outage (Resend's error codes: 429 for rate and quota, 5xx).
  it.each([429, 500, 503])("a %i is a refusal", async (status) => {
    const sender = resendSender(
      "re_test_key",
      answering(() => new Response("{}", { status })),
    );
    expect(await sender.sendBatch([email])).toEqual({ outcome: "refused", status });
  });

  it("a network error is a refusal", async () => {
    const sender = resendSender("re_test_key", async () => {
      throw new TypeError("network down");
    });
    expect(await sender.sendBatch([email])).toEqual({ outcome: "refused", status: 0 });
  });

  it("a call that never answers times out as a refusal", async () => {
    // Answers only by rejecting when the sender aborts the request.
    const hanging: typeof fetch = (_input, init) =>
      new Promise((_, reject) =>
        init?.signal?.addEventListener("abort", () => reject(init.signal!.reason)),
      );
    const sender = resendSender("re_test_key", hanging, 10);
    expect(await sender.sendBatch([email])).toEqual({ outcome: "refused", status: 0 });
  });

  it("an accepted batch whose answer can't be read is still sent", async () => {
    const sender = resendSender(
      "re_test_key",
      answering(() => new Response("<html>", { status: 200 })),
    );
    expect(await sender.sendBatch([email])).toEqual({ outcome: "sent", ids: [] });
  });

  it.each([
    ["null", []],
    ['{"data":null}', []],
    [
      '{"data":[null,{"id":"resend-2"},{"id":"reader@example.test"},{"id":{"to":"x"}}]}',
      ["resend-2"],
    ],
  ])("an accepted batch answered with %s keeps only well-formed IDs", async (body, ids) => {
    const sender = resendSender(
      "re_test_key",
      answering(() => new Response(body, { status: 200 })),
    );
    expect(await sender.sendBatch([email])).toEqual({ outcome: "sent", ids });
  });

  it("asks for permissive batch validation", async () => {
    let headers: Headers | undefined;
    const fetcher: typeof fetch = async (_input, init) => {
      headers = new Headers(init?.headers);
      return Response.json({ data: [{ id: "resend-1" }] });
    };
    await resendSender("re_test_key", fetcher).sendBatch([email]);
    expect(headers?.get("x-batch-validation")).toBe("permissive");
  });

  // The permissive answer shape is from resend-node's batch types; Resend's API reference
  // doesn't document it. `index` is the position in the request.
  it("an accepted batch reports the emails Resend refused by their index, never their text", async () => {
    const sender = resendSender(
      "re_test_key",
      answering(() =>
        Response.json(
          {
            data: [{ id: "resend-1" }, { id: "resend-3" }],
            errors: [{ index: 1, message: "bad reader@example.test" }],
          },
          { status: 202 },
        ),
      ),
    );
    const result = await sender.sendBatch([email, email, email]);
    expect(result).toEqual({ outcome: "sent", ids: ["resend-1", "resend-3"], rejected: [1] });
  });

  it("keeps only whole-number indexes inside the batch from the errors", async () => {
    const sender = resendSender(
      "re_test_key",
      answering(() =>
        Response.json({
          data: [],
          errors: [null, { index: "0" }, { index: -1 }, { index: 1.5 }, { index: 3 }, { index: 2 }],
        }),
      ),
    );
    expect(await sender.sendBatch([email, email, email])).toEqual({
      outcome: "sent",
      ids: [],
      rejected: [2],
    });
  });

  it.each([400, 401, 403, 422])("a %i is a failure, not a refusal", async (status) => {
    const sender = resendSender(
      "re_test_key",
      answering(() => new Response("{}", { status })),
    );
    expect(await sender.sendBatch([email])).toEqual({ outcome: "failed", status });
  });
});
