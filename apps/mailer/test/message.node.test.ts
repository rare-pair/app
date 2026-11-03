import { describe, expect, it } from "vitest";
import { parseMessage } from "../src/message";
import { render } from "../src/render";

const FROM = "rarepair <sign-in@mail.example.test>";
const TO = "reader@example.test";

const waitlist = (url: string) => ({ kind: "waitlist-confirm", to: TO, url });
const signIn = (url: string) => ({ kind: "sign-in", to: TO, url });

describe("the email queue's message contract", () => {
  it("accepts a wait list confirmation email linking to /waitlist/confirm with a token", () => {
    const url = "https://rarepair.fans/waitlist/confirm?token=abc_DEF-123";
    expect(parseMessage(waitlist(url))).toEqual({ kind: "waitlist-confirm", to: TO, url });
  });

  it("still accepts a sign-in email linking to /login/confirm", () => {
    const url = "https://rarepair.fans/login/confirm?token=abc";
    expect(parseMessage(signIn(url))).toEqual({ kind: "sign-in", to: TO, url });
  });

  it.each([
    ["the sign-in path", "https://rarepair.fans/login/confirm?token=abc"],
    ["another host", "https://evil.example/waitlist/confirm?token=abc"],
    ["a sibling host", "https://content.rarepair.fans/waitlist/confirm?token=abc"],
    ["www", "https://www.rarepair.fans/waitlist/confirm?token=abc"],
    ["http", "http://rarepair.fans/waitlist/confirm?token=abc"],
    ["another port", "https://rarepair.fans:8443/waitlist/confirm?token=abc"],
    ["user info", "https://evil.example@rarepair.fans/waitlist/confirm?token=abc"],
    ["a fragment", "https://rarepair.fans/waitlist/confirm?token=abc#more"],
    ["an empty fragment", "https://rarepair.fans/waitlist/confirm?token=abc#"],
    ["a longer path", "https://rarepair.fans/waitlist/confirm/x?token=abc"],
    ["a path with a suffix", "https://rarepair.fans/waitlist/confirmx?token=abc"],
    ["the bare site", "https://rarepair.fans/"],
    ["no token", "https://rarepair.fans/waitlist/confirm"],
    ["an empty token", "https://rarepair.fans/waitlist/confirm?token="],
    ["another parameter only", "https://rarepair.fans/waitlist/confirm?next=abc"],
    ["another parameter too", "https://rarepair.fans/waitlist/confirm?token=abc&email=a%40b.test"],
    ["two tokens", "https://rarepair.fans/waitlist/confirm?token=abc&token=def"],
    ["a token that isn't base64url", "https://rarepair.fans/waitlist/confirm?token=a%40b.test"],
    ["javascript", "javascript:alert(1)"],
    ["not a URL", "not a url"],
    ["too long", `https://rarepair.fans/waitlist/confirm?token=${"x".repeat(2048)}`],
  ])("refuses a wait list confirmation email with %s", (_, url) => {
    expect(parseMessage(waitlist(url))).toBeNull();
  });

  it("refuses a sign-in email with an empty fragment", () => {
    expect(parseMessage(signIn("https://rarepair.fans/login/confirm?token=abc#"))).toBeNull();
  });

  it("refuses a sign-in email linking to /waitlist/confirm", () => {
    expect(parseMessage(signIn("https://rarepair.fans/waitlist/confirm?token=abc"))).toBeNull();
  });

  it.each([
    ["a display name", "Reader <reader@example.test>"],
    ["a list", "reader@example.test, other@example.test"],
    ["inner whitespace", "read er@example.test"],
    ["no @", "reader.example.test"],
    ["over 254 characters", `${"a".repeat(250)}@example.test`],
    ["a NUL", "read\u0000er@example.test"],
    ["an escape", "read\u001ber@example.test"],
    ["a DEL", "read\u007fer@example.test"],
    ["a C1 next-line", "read\u0085er@example.test"],
  ])("refuses a wait list confirmation email to %s", (_, to) => {
    const url = "https://rarepair.fans/waitlist/confirm?token=abc";
    expect(parseMessage({ kind: "waitlist-confirm", to, url })).toBeNull();
  });

  it("drops line breaks from a wait list link", () => {
    const parsed = parseMessage(
      waitlist("https://rarepair.fans/waitlist/confirm?token=x\n\nInjected\n"),
    );
    expect(parsed?.url).toBe("https://rarepair.fans/waitlist/confirm?token=xInjected");
    // And a line with a space in it can't be smuggled into the token at all.
    expect(
      parseMessage(waitlist("https://rarepair.fans/waitlist/confirm?token=x\n\nInjected line\n")),
    ).toBeNull();
  });
});

describe("16-removal-and-opt-out: the removal confirmation email", () => {
  const removal = (url: string) => ({ kind: "removal-confirm", to: TO, url });

  it("Removal confirmation email links to /remove/confirm with a token", () => {
    const url = "https://rarepair.fans/remove/confirm?token=abc_DEF-123";
    expect(parseMessage(removal(url))).toEqual({ kind: "removal-confirm", to: TO, url });
  });

  it.each([
    ["the wait list path", "https://rarepair.fans/waitlist/confirm?token=abc"],
    ["the sign-in path", "https://rarepair.fans/login/confirm?token=abc"],
    ["the form", "https://rarepair.fans/remove?token=abc"],
    ["another host", "https://evil.example/remove/confirm?token=abc"],
    ["a fragment", "https://rarepair.fans/remove/confirm?token=abc#x"],
    ["no token", "https://rarepair.fans/remove/confirm"],
    ["another parameter too", "https://rarepair.fans/remove/confirm?token=abc&work=1"],
  ])("Removal confirmation email with %s is refused", (_, url) => {
    expect(parseMessage(removal(url))).toBeNull();
  });

  it("Other kinds linking to /remove/confirm are refused", () => {
    const url = "https://rarepair.fans/remove/confirm?token=abc";
    expect(parseMessage(signIn(url))).toBeNull();
    expect(parseMessage(waitlist(url))).toBeNull();
  });

  it("Removal confirmation email says what the link does and names no work", () => {
    const url = "https://rarepair.fans/remove/confirm?token=abc";
    const email = render({ kind: "removal-confirm", to: TO, url }, FROM);
    expect(email.to).toBe(TO);
    expect(email.subject).toMatch(/confirm/i);
    expect(email.subject).toMatch(/removal/i);
    expect(email.text).toContain(url);
    expect(email.text).toMatch(/7 days/);
    expect(email.text).toMatch(/once/i);
    expect(email.text).toMatch(/ignore this email/i);
    expect(email.text).not.toMatch(/\/works\//);
  });
});

describe("rendering the wait list confirmation email", () => {
  it("says what the link does, how long it lasts and what else will come", () => {
    const url = "https://rarepair.fans/waitlist/confirm?token=abc";
    const email = render({ kind: "waitlist-confirm", to: TO, url }, FROM);
    expect(email.from).toBe(FROM);
    expect(email.to).toBe(TO);
    expect(email.subject).toMatch(/confirm/i);
    expect(email.subject).toMatch(/wait list/i);
    expect(email.text).toContain(url);
    expect(email.text).toMatch(/7 days/);
    expect(email.text).toMatch(/one email when the archive opens/i);
    expect(email.text).toMatch(/ignore this email/i);
  });

  it("keeps the sign-in email as it was", () => {
    const url = "https://rarepair.fans/login/confirm?token=abc";
    const email = render({ kind: "sign-in", to: TO, url }, FROM);
    expect(email.subject).toBe("Your sign-in link for rarepair");
    expect(email.text).toContain("only for 15 minutes");
  });
});
