import { createContext, runInContext, Script } from "node:vm";
import { describe, expect, it } from "vitest";
import { UPLOAD_SCRIPT } from "../src/upload-script";

// U3's browser half, run as text over hand-written fakes for the page's DOM, `fetch`,
// `XMLHttpRequest` and Turnstile. It shows what the script asks for and sends, not how a
// real browser, the CSP or R2's CORS answer: that is the manual check in the PR.

type Fake = { name: string; size: number };
type Row = { children: FakeElement[] };

class FakeElement {
  children: FakeElement[] = [];
  textContent = "";
  hidden = false;
  disabled = false;
  max = 0;
  value = 0;
  files: Fake[] = [];
  attributes: Record<string, string> = {};
  listeners: Record<string, () => Promise<void>> = {};
  appendChild(child: FakeElement) {
    this.children.push(child);
    return child;
  }
  replaceChildren() {
    this.children = [];
  }
  setAttribute(name: string, value: string) {
    this.attributes[name] = value;
  }
  addEventListener(type: string, listener: () => Promise<void>) {
    this.listeners[type] = listener;
  }
}

type Progress = { lengthComputable: boolean; loaded: number; total: number };

class FakeUpload {
  onprogress?: (event: Progress) => void;
}

class FakeXhr {
  static all: FakeXhr[] = [];
  method = "";
  url = "";
  headers: Record<string, string> = {};
  sent: Fake | null = null;
  status = 0;
  upload = new FakeUpload();
  onload?: () => void;
  onerror?: () => void;
  onabort?: () => void;
  ontimeout?: () => void;
  constructor() {
    FakeXhr.all.push(this);
  }
  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(name: string, value: string) {
    this.headers[name] = value;
  }
  send(body: Fake) {
    this.sent = body;
  }
  abort() {
    this.onabort?.();
  }
}

/** A timer the test fires itself. */
class FakeTimer {
  cleared = false;
  constructor(
    readonly ms: number,
    private readonly run: () => void,
  ) {}
  fire() {
    if (!this.cleared) this.run();
  }
}

type Call = { url: string; method: string; body: URLSearchParams | undefined };

/** Loads the script into a fresh page with `files` picked, and returns the handles to drive it. */
function page(files: Fake[], replies: ((call: Call) => { status: number; body: object })[]) {
  FakeXhr.all = [];
  const elements = Object.fromEntries(
    ["file", "send", "message", "files"].map((id) => [id, new FakeElement()]),
  );
  elements["file"]!.files = files;
  const calls: Call[] = [];
  const clock = { now: 1_000_000 };
  const timers: FakeTimer[] = [];
  const turnstile = {
    token: "token-1",
    resets: 0,
    getResponse: () => turnstile.token,
    reset: () => turnstile.resets++,
  };
  const globals = {
    document: {
      getElementById: (id: string) => elements[id] ?? null,
      createElement: () => new FakeElement(),
    },
    fetch: async (url: string, init: { method: string; body?: URLSearchParams }) => {
      const call = { url, method: init.method, body: init.body };
      calls.push(call);
      const reply = replies[calls.length - 1]!(call);
      return { ok: reply.status < 300, status: reply.status, json: async () => reply.body };
    },
    Date: { now: () => clock.now },
    setTimeout: (run: () => void, ms: number) => timers.push(new FakeTimer(ms, run)) - 1,
    clearTimeout: (id: number) => {
      timers[id]!.cleared = true;
    },
    XMLHttpRequest: FakeXhr,
    URLSearchParams,
    turnstile,
  };
  // The script reaches Turnstile as window.turnstile; the page's globals are the same object.
  const context = createContext({ ...globals, window: globals });
  runInContext(UPLOAD_SCRIPT, context);
  const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
  return {
    calls,
    clock,
    timers,
    turnstile,
    button: elements["send"]!,
    message: elements["message"]!,
    rows: () => elements["files"]!.children,
    click: async () => {
      await elements["send"]!.listeners["click"]!();
    },
    flush,
  };
}

const bar = (row: Row) => row.children[1]!;
const note = (row: Row) => row.children[2]!.textContent;
const epub = (n: number, size = 1000 + n): Fake => ({ name: `book-${n}.epub`, size });
const sizesOf = (body: URLSearchParams | undefined) => body?.getAll("size");
const done = (xhr: FakeXhr, status = 200) => {
  xhr.status = status;
  xhr.onload!();
};

describe("script", () => {
  it("is valid JavaScript", () => {
    expect(() => new Script(UPLOAD_SCRIPT)).not.toThrow();
  });
});

describe("02-upload-handshake", () => {
  it("Browser with JS uploads straight to R2 with progress", async () => {
    const file = epub(1, 5000);
    const p = page(
      [file],
      [
        () => ({ status: 200, body: { id: "up-1", url: "https://r2.example/put-1" } }),
        () => ({ status: 200, body: { status: "queued" } }),
      ],
    );
    const clicked = p.click();
    await p.flush();

    // One ask, with the size and the token; the file itself is not in it.
    expect(p.calls[0]).toMatchObject({ url: "/uploads", method: "POST" });
    expect(sizesOf(p.calls[0]!.body)).toEqual(["5000"]);
    expect(p.calls[0]!.body?.get("cf-turnstile-response")).toBe("token-1");
    // A token is single use.
    expect(p.turnstile.resets).toBe(1);

    // The file goes to the presigned URL, with the one type that URL signs.
    const [xhr] = FakeXhr.all;
    expect(xhr).toMatchObject({ method: "PUT", url: "https://r2.example/put-1", sent: file });
    expect(xhr!.headers).toEqual({ "Content-Type": "application/epub+zip" });

    // Progress moves the file's own bar.
    xhr!.upload.onprogress!({ lengthComputable: true, loaded: 2500, total: 5000 });
    expect(bar(p.rows()[0]!)).toMatchObject({ max: 5000, value: 2500 });

    done(xhr!);
    await clicked;
    // Finished, so confirmed; only `/complete` and the ask ever went through fetch.
    expect(p.calls.map((c) => [c.method, c.url])).toEqual([
      ["POST", "/uploads"],
      ["POST", "/uploads/up-1/complete"],
    ]);
    expect(note(p.rows()[0]!)).toMatch(/Uploaded/);
    expect(p.button.disabled).toBe(false);
  });

  it("Upload of several files in one go", async () => {
    const files = [epub(1), epub(2), epub(3)];
    const p = page(files, [
      () => ({
        status: 200,
        body: {
          uploads: [
            { id: "a", url: "https://r2.example/a" },
            { id: "b", url: "https://r2.example/b" },
            { id: "c", url: "https://r2.example/c" },
          ],
        },
      }),
      () => ({ status: 200, body: { status: "queued" } }),
      () => ({ status: 200, body: { status: "duplicate" } }),
      () => ({ status: 200, body: { status: "queued" } }),
    ]);
    const clicked = p.click();
    await p.flush();

    // One ask for all three, under one token.
    expect(p.calls).toHaveLength(1);
    expect(sizesOf(p.calls[0]!.body)).toEqual(["1001", "1002", "1003"]);
    expect(p.turnstile.resets).toBe(1);

    // Each file goes to its own URL, and its progress moves its own bar only.
    expect(FakeXhr.all.map((x) => [x.url, x.sent])).toEqual([
      ["https://r2.example/a", files[0]],
      ["https://r2.example/b", files[1]],
      ["https://r2.example/c", files[2]],
    ]);
    FakeXhr.all[1]!.upload.onprogress!({ lengthComputable: true, loaded: 400, total: 1002 });
    expect(p.rows().map((r) => bar(r).value)).toEqual([0, 400, 0]);

    for (const xhr of FakeXhr.all) done(xhr);
    await clicked;
    // Each finished transfer is confirmed, by its own id.
    expect(
      p.calls
        .slice(1)
        .map((c) => c.url)
        .sort(),
    ).toEqual(["/uploads/a/complete", "/uploads/b/complete", "/uploads/c/complete"]);
    expect(p.rows().map(note)).toEqual([
      expect.stringMatching(/Uploaded/),
      expect.stringMatching(/already/),
      expect.stringMatching(/Uploaded/),
    ]);
  });

  it("Sends at most three files at a time, so later URLs don't expire waiting", async () => {
    const files = [1, 2, 3, 4, 5].map((n) => epub(n));
    const ids = ["a", "b", "c", "d", "e"];
    const p = page(files, [
      () => ({
        status: 200,
        body: { uploads: ids.map((id) => ({ id, url: `https://r2.example/${id}` })) },
      }),
      ...ids.map(() => () => ({ status: 200, body: { status: "queued" } })),
    ]);
    const clicked = p.click();
    await p.flush();
    expect(FakeXhr.all).toHaveLength(3);
    done(FakeXhr.all[0]!);
    await p.flush();
    expect(FakeXhr.all).toHaveLength(4);
    for (let i = 1; i < 5; i++) {
      await p.flush();
      done(FakeXhr.all[i]!);
    }
    await clicked;
    expect(FakeXhr.all).toHaveLength(5);
  });

  it("An error reply is shown and nothing is sent to R2", async () => {
    const p = page(
      [epub(1), epub(2)],
      [() => ({ status: 429, body: { error: "You have 1 upload left today.", retryAfter: 60 } })],
    );
    await p.click();
    expect(p.message.textContent).toBe("You have 1 upload left today.");
    expect(FakeXhr.all).toHaveLength(0);
    expect(p.turnstile.resets).toBe(1);
    expect(p.rows().map(note)).toEqual(["Not uploaded.", "Not uploaded."]);
    expect(p.button.disabled).toBe(false);
  });

  it("A file that is not an epub or is over 25 MB is refused before anything is asked", async () => {
    const p = page(
      [
        { name: "notes.txt", size: 10 },
        { name: "big.epub", size: 26214401 },
        { name: "empty.epub", size: 0 },
      ],
      [],
    );
    await p.click();
    expect(p.calls).toHaveLength(0);
    expect(p.rows().map(note)).toEqual([
      expect.stringMatching(/Not an epub/),
      expect.stringMatching(/over the 25 MB limit/i),
      expect.stringMatching(/empty/),
    ]);
  });

  it("Only the files that pass are asked for", async () => {
    const p = page(
      [{ name: "notes.txt", size: 10 }, epub(2, 77)],
      [
        () => ({ status: 200, body: { id: "x", url: "https://r2.example/x" } }),
        () => ({ status: 200, body: { status: "queued" } }),
      ],
    );
    const clicked = p.click();
    await p.flush();
    expect(sizesOf(p.calls[0]!.body)).toEqual(["77"]);
    done(FakeXhr.all[0]!);
    await clicked;
  });

  it("More than ten files are refused before anything is asked", async () => {
    const p = page(
      Array.from({ length: 11 }, (_, i) => epub(i)),
      [],
    );
    await p.click();
    expect(p.calls).toHaveLength(0);
    expect(p.message.textContent).toMatch(/10 files/);
  });

  it("Asks nothing until the anti-spam check has an answer", async () => {
    const p = page([epub(1)], []);
    p.turnstile.token = "";
    await p.click();
    expect(p.calls).toHaveLength(0);
    expect(p.message.textContent).toMatch(/anti-spam/);
  });

  it("A transfer that fails is not confirmed and says to try again", async () => {
    const p = page(
      [epub(1)],
      [() => ({ status: 200, body: { id: "up-1", url: "https://r2.example/put-1" } })],
    );
    const clicked = p.click();
    await p.flush();
    done(FakeXhr.all[0]!, 403);
    await clicked;
    expect(p.calls).toHaveLength(1);
    expect(note(p.rows()[0]!)).toMatch(/try again/);
  });

  it("A transfer that stops moving is ended, and one that moves is not", async () => {
    const p = page(
      [epub(1)],
      [() => ({ status: 200, body: { id: "up-1", url: "https://r2.example/put-1" } })],
    );
    const clicked = p.click();
    await p.flush();
    const [first] = p.timers;
    expect(first!.ms).toBe(120000);
    // Progress restarts the wait.
    FakeXhr.all[0]!.upload.onprogress!({ lengthComputable: true, loaded: 1, total: 1001 });
    expect(first!.cleared).toBe(true);
    expect(p.timers).toHaveLength(2);
    // Past the stall, the transfer is aborted.
    p.timers[1]!.fire();
    await clicked;
    expect(note(p.rows()[0]!)).toMatch(/try again/);
    expect(p.button.disabled).toBe(false);
  });

  it("Files the script refuses don't count towards the ten", async () => {
    const files = [...Array.from({ length: 9 }, (_, i) => epub(i)), epub(10), epub(11)];
    files[9] = { name: "notes.txt", size: 5 };
    files[10] = { name: "more.txt", size: 5 };
    const p = page(files, [
      () => ({
        status: 200,
        body: {
          uploads: files
            .slice(0, 9)
            .map((_, i) => ({ id: `i${i}`, url: `https://r2.example/${i}` })),
        },
      }),
    ]);
    const clicked = p.click();
    await p.flush();
    expect(sizesOf(p.calls[0]!.body)).toHaveLength(9);
    // Nine go out, three at a time; fail each as it starts so the click finishes.
    for (let i = 0; i < 9; i++) {
      await p.flush();
      FakeXhr.all[i]!.onerror!();
    }
    await clicked;
    expect(FakeXhr.all).toHaveLength(9);
  });

  it("A file that would start after its URL has expired is not sent", async () => {
    const files = [1, 2, 3, 4].map((n) => epub(n));
    const ids = ["a", "b", "c", "d"];
    const p = page(files, [
      () => ({
        status: 200,
        body: { uploads: ids.map((id) => ({ id, url: `https://r2.example/${id}` })) },
      }),
      () => ({ status: 200, body: { status: "queued" } }),
    ]);
    const clicked = p.click();
    await p.flush();
    // Past ten minutes from signing, the fourth file's URL is dead, so it never starts.
    p.clock.now += 601000;
    done(FakeXhr.all[0]!);
    FakeXhr.all[1]!.onerror!();
    FakeXhr.all[2]!.onerror!();
    await clicked;
    expect(FakeXhr.all).toHaveLength(3);
    expect(note(p.rows()[3]!)).toMatch(/try again/);
  });

  it("A second click sends only the files not yet uploaded", async () => {
    const files = [epub(1), epub(2)];
    const p = page(files, [
      () => ({
        status: 200,
        body: {
          uploads: [
            { id: "a", url: "https://r2.example/a" },
            { id: "b", url: "https://r2.example/b" },
          ],
        },
      }),
      () => ({ status: 200, body: { status: "queued" } }),
      () => ({ status: 200, body: { id: "c", url: "https://r2.example/c" } }),
      () => ({ status: 200, body: { status: "queued" } }),
    ]);
    const first = p.click();
    await p.flush();
    done(FakeXhr.all[0]!);
    FakeXhr.all[1]!.onerror!();
    await first;

    const second = p.click();
    await p.flush();
    // Only the file that failed is asked for again.
    expect(sizesOf(p.calls[2]!.body)).toEqual(["1002"]);
    expect(p.rows().map(note)[0]).toMatch(/Already uploaded/);
    done(FakeXhr.all[2]!);
    await second;
  });

  it("A network error on a transfer is shown too", async () => {
    const p = page(
      [epub(1)],
      [() => ({ status: 200, body: { id: "up-1", url: "https://r2.example/put-1" } })],
    );
    const clicked = p.click();
    await p.flush();
    FakeXhr.all[0]!.onerror!();
    await clicked;
    expect(p.calls).toHaveLength(1);
    expect(note(p.rows()[0]!)).toMatch(/try again/);
  });
});
