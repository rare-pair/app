import { createContext, runInContext, Script } from "node:vm";
import { deflateRawSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import { UPLOAD_SCRIPT } from "../src/upload-script";

// U3's browser half, run as text over hand-written fakes for the page's DOM, `fetch`,
// `XMLHttpRequest` and Turnstile. It shows what the script asks for and sends, not how a
// real browser or the CSP answer: that is the browser suite's (browser/journeys/).

type Fake = { name: string; size: number };
type Row = { children: FakeElement[] };

/** Each element the page gave focus, in order. */
let focusLog: FakeElement[] = [];

type FakeEvent = { preventDefault: () => void; dataTransfer?: { files: Fake[] } };

class FakeElement {
  children: FakeElement[] = [];
  textContent = "";
  hidden = false;
  disabled = false;
  max = 0;
  value = 0;
  files: Fake[] = [];
  attributes: Record<string, string> = {};
  listeners: Record<string, (event?: FakeEvent) => Promise<void> | void> = {};
  classes = new Set<string>();
  classList = {
    add: (name: string) => this.classes.add(name),
    remove: (name: string) => this.classes.delete(name),
  };
  appendChild(child: FakeElement) {
    this.children.push(child);
    return child;
  }
  contains() {
    return false;
  }
  removeChild(child: FakeElement) {
    this.children = this.children.filter((one) => one !== child);
  }
  focus() {
    focusLog.push(this);
  }
  replaceChildren() {
    this.children = [];
  }
  setAttribute(name: string, value: string) {
    this.attributes[name] = value;
  }
  addEventListener(type: string, listener: (event?: FakeEvent) => Promise<void> | void) {
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
  responseText = "";
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
function page(
  files: Fake[],
  replies: ((call: Call) => { status: number; body: object })[],
  // Browser features the zip reader uses; `{ DecompressionStream: undefined }` is a browser without it.
  browser: { DecompressionStream?: unknown } = {},
) {
  FakeXhr.all = [];
  const elements = Object.fromEntries(
    ["file", "send", "message", "files", "drop"].map((id) => [id, new FakeElement()]),
  );
  focusLog = [];
  elements["file"]!.files = files;
  const calls: Call[] = [];
  // The uploads the page has reported as failed. Each is answered without using up a reply.
  const reported: string[] = [];
  const timers: FakeTimer[] = [];
  const turnstile = {
    token: "token-1",
    resets: 0,
    // How many times `getResponse` answers with nothing after a reset, as a check still running does.
    slowBy: 0,
    waiting: 0,
    getResponse: () => {
      if (turnstile.waiting > 0) {
        turnstile.waiting--;
        return "";
      }
      return turnstile.token;
    },
    reset: () => {
      turnstile.resets++;
      turnstile.token = `token-${turnstile.resets + 1}`;
      turnstile.waiting = turnstile.slowBy;
    },
  };
  const globals = {
    document: {
      getElementById: (id: string) => elements[id] ?? null,
      createElement: () => new FakeElement(),
      addEventListener: () => undefined,
    },
    fetch: async (url: string, init: { method: string; body?: URLSearchParams }) => {
      if (init.method === "DELETE") {
        reported.push(url);
        return { ok: true, status: 200, json: async () => ({ status: "freed" }) };
      }
      const call = { url, method: init.method, body: init.body };
      calls.push(call);
      const reply = replies[calls.length - 1]!(call);
      if (reply.status === 0) throw new TypeError("Failed to fetch");
      return { ok: reply.status < 300, status: reply.status, json: async () => reply.body };
    },
    setTimeout: (run: () => void, ms: number) => {
      // A short wait, such as the poll for a token, passes at once; a long one is the test's to fire.
      if (ms < 1000) setImmediate(run);
      return timers.push(new FakeTimer(ms, run)) - 1;
    },
    clearTimeout: (id: number) => {
      timers[id]!.cleared = true;
    },
    XMLHttpRequest: FakeXhr,
    File,
    Blob,
    TextDecoder,
    DecompressionStream,
    ...browser,
    URLSearchParams,
    AbortSignal,
    turnstile,
  };
  // The script reaches Turnstile as window.turnstile; the page's globals are the same object.
  const context = createContext({ ...globals, window: globals });
  runInContext(UPLOAD_SCRIPT, context);
  // The files are in the input as the script loads; picking them is the input's change.
  void elements["file"]!.listeners["change"]?.();
  const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
  return {
    calls,
    reported,
    timers,
    turnstile,
    button: elements["send"]!,
    input: elements["file"]!,
    drop: elements["drop"]!,
    pick: (more: Fake[]) => {
      elements["file"]!.files = more;
      void elements["file"]!.listeners["change"]?.();
    },
    focused: () => focusLog[focusLog.length - 1],
    // Turnstile's call back to the page, for a check that needs the person.
    interact: () => runInContext("window.onTurnstileInteractive()", context),
    message: elements["message"]!,
    rows: () => elements["files"]!.children,
    click: async () => {
      await elements["send"]!.listeners["click"]!();
    },
    flush,
  };
}

// A row is its name, size, Remove button, progress bar and note.
const name = (row: Row) => row.children[0]!.textContent.trim();
const size = (row: Row) => row.children[1]!.textContent;
const remove = (row: Row) => row.children[2]!;
const bar = (row: Row) => row.children[3]!;
const note = (row: Row) => row.children[4]!.textContent;
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
  it("Browser with JS sends a file through the Worker with progress", async () => {
    const file = epub(1, 5000);
    const p = page(
      [file],
      [
        () => ({ status: 200, body: { id: "up-1" } }),
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

    // The file goes to its upload's address on this site, with the one type that takes.
    const [xhr] = FakeXhr.all;
    expect(xhr).toMatchObject({ method: "PUT", url: "/uploads/up-1", sent: file });
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
    // Nothing failed, so nothing is reported.
    expect(p.reported).toEqual([]);
  });

  it("Upload of several files in one go", async () => {
    const files = [epub(1), epub(2), epub(3)];
    const p = page(files, [
      () => ({
        status: 200,
        body: {
          uploads: [{ id: "a" }, { id: "b" }, { id: "c" }],
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

    // Each file goes to its own address, and its progress moves its own bar only.
    expect(FakeXhr.all.map((x) => [x.url, x.sent])).toEqual([
      ["/uploads/a", files[0]],
      ["/uploads/b", files[1]],
      ["/uploads/c", files[2]],
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

  it("Sends at most three files at a time", async () => {
    const files = [1, 2, 3, 4, 5].map((n) => epub(n));
    const ids = ["a", "b", "c", "d", "e"];
    const p = page(files, [
      () => ({
        status: 200,
        body: { uploads: ids.map((id) => ({ id })) },
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

  it("An error reply is shown and nothing is sent", async () => {
    const p = page(
      [epub(1), epub(2)],
      [
        () => ({
          status: 429,
          body: { error: "You have 1 upload left today.", retryAfter: 40000 },
        }),
      ],
    );
    await p.click();
    expect(p.message.textContent).toBe("You have 1 upload left today.");
    expect(FakeXhr.all).toHaveLength(0);
    expect(p.turnstile.resets).toBe(1);
    expect(p.rows().map(note)).toEqual([
      expect.stringMatching(/Not uploaded/),
      expect.stringMatching(/Not uploaded/),
    ]);
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
    // The problems show in the list as the files are added, before anything is sent.
    expect(p.rows().map(note)).toEqual([
      expect.stringMatching(/Not an epub/),
      expect.stringMatching(/over the 25 MB limit/i),
      expect.stringMatching(/empty/),
    ]);
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
        () => ({ status: 200, body: { id: "x" } }),
        () => ({ status: 200, body: { status: "queued" } }),
      ],
    );
    const clicked = p.click();
    await p.flush();
    expect(sizesOf(p.calls[0]!.body)).toEqual(["77"]);
    done(FakeXhr.all[0]!);
    await clicked;
  });

  it("Asks nothing until the anti-spam check has an answer", async () => {
    const p = page([epub(1)], []);
    p.turnstile.token = "";
    await p.click();
    expect(p.calls).toHaveLength(0);
    expect(p.message.textContent).toMatch(/anti-spam/);
  });

  it("A transfer that fails is not confirmed, says to try again and is reported", async () => {
    const p = page([epub(1)], [() => ({ status: 200, body: { id: "up-1" } })]);
    const clicked = p.click();
    await p.flush();
    done(FakeXhr.all[0]!, 403);
    await clicked;
    expect(p.calls).toHaveLength(1);
    expect(note(p.rows()[0]!)).toMatch(/try again/);
    expect(p.reported).toEqual(["/uploads/up-1"]);
  });

  it("A confirm that never reaches the server is reported", async () => {
    const p = page(
      [epub(1)],
      [() => ({ status: 200, body: { id: "up-1" } }), () => ({ status: 0, body: {} })],
    );
    const clicked = p.click();
    await p.flush();
    done(FakeXhr.all[0]!);
    await clicked;
    expect(note(p.rows()[0]!)).toMatch(/try again/);
    expect(p.reported).toEqual(["/uploads/up-1"]);
  });

  it("A confirm the server refuses isn't reported: the server has settled it", async () => {
    const p = page(
      [epub(1)],
      [
        () => ({ status: 200, body: { id: "up-1" } }),
        () => ({ status: 400, body: { error: "That file didn't finish uploading." } }),
      ],
    );
    const clicked = p.click();
    await p.flush();
    done(FakeXhr.all[0]!);
    await clicked;
    expect(note(p.rows()[0]!)).toMatch(/didn't finish/);
    expect(p.reported).toEqual([]);
  });

  it("A confirm that ends in a server fault is reported: the Worker may never have freed it", async () => {
    const p = page(
      [epub(1)],
      [() => ({ status: 200, body: { id: "up-1" } }), () => ({ status: 502, body: {} })],
    );
    const clicked = p.click();
    await p.flush();
    done(FakeXhr.all[0]!);
    await clicked;
    expect(note(p.rows()[0]!)).toMatch(/try again/);
    expect(p.reported).toEqual(["/uploads/up-1"]);
  });

  it("A transfer answered 409 goes on to the confirm and isn't reported", async () => {
    // A PUT that was stored and whose answer was lost, sent again by the browser, gets a 409.
    const p = page(
      [epub(1)],
      [
        () => ({ status: 200, body: { id: "up-1" } }),
        () => ({ status: 200, body: { status: "queued" } }),
      ],
    );
    const clicked = p.click();
    await p.flush();
    done(FakeXhr.all[0]!, 409);
    await clicked;
    expect(p.calls.map((c) => c.url)).toEqual(["/uploads", "/uploads/up-1/complete"]);
    expect(note(p.rows()[0]!)).toMatch(/Uploaded/);
    expect(p.reported).toEqual([]);
  });

  it("A refused transfer shows the server's reason", async () => {
    const p = page([epub(1)], [() => ({ status: 200, body: { id: "up-1" } })]);
    const clicked = p.click();
    await p.flush();
    FakeXhr.all[0]!.responseText = JSON.stringify({ error: "This account can't upload." });
    done(FakeXhr.all[0]!, 403);
    await clicked;
    expect(note(p.rows()[0]!)).toBe("This account can't upload.");
  });

  it("A transfer answered with no JSON still says to try again", async () => {
    const p = page([epub(1)], [() => ({ status: 200, body: { id: "up-1" } })]);
    const clicked = p.click();
    await p.flush();
    FakeXhr.all[0]!.responseText = "<html>Bad gateway</html>";
    done(FakeXhr.all[0]!, 502);
    await clicked;
    expect(note(p.rows()[0]!)).toMatch(/try again/);
  });

  it("A transfer that stops moving is ended, and one that moves is not", async () => {
    const p = page([epub(1)], [() => ({ status: 200, body: { id: "up-1" } })]);
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
    expect(p.reported).toEqual(["/uploads/up-1"]);
  });

  it("Files the script refuses don't count towards the ten", async () => {
    const files = [...Array.from({ length: 9 }, (_, i) => epub(i)), epub(10), epub(11)];
    files[9] = { name: "notes.txt", size: 5 };
    files[10] = { name: "more.txt", size: 5 };
    const p = page(files, [
      () => ({
        status: 200,
        body: {
          uploads: files.slice(0, 9).map((_, i) => ({ id: `i${i}` })),
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

  it("A second click sends only the files not yet uploaded", async () => {
    const files = [epub(1), epub(2)];
    const p = page(files, [
      () => ({
        status: 200,
        body: {
          uploads: [{ id: "a" }, { id: "b" }],
        },
      }),
      () => ({ status: 200, body: { status: "queued" } }),
      () => ({ status: 200, body: { id: "c" } }),
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
    expect(p.rows().map(note)[0]).toMatch(/Uploaded/);
    done(FakeXhr.all[2]!);
    await second;
  });

  it("A network error on a transfer is shown and reported too", async () => {
    const p = page([epub(1)], [() => ({ status: 200, body: { id: "up-1" } })]);
    const clicked = p.click();
    await p.flush();
    FakeXhr.all[0]!.onerror!();
    await clicked;
    expect(p.calls).toHaveLength(1);
    expect(note(p.rows()[0]!)).toMatch(/try again/);
    expect(p.reported).toEqual(["/uploads/up-1"]);
  });

  it("Picked and dropped files wait in a list until Upload", async () => {
    const p = page([epub(1, 2048), epub(2, 3 * 1024 * 1024)], []);
    expect(p.rows().map(name)).toEqual(["book-1.epub", "book-2.epub"]);
    expect(p.rows().map(size)).toEqual([
      expect.stringContaining("2 KB"),
      expect.stringContaining("3.0 MB"),
    ]);
    expect(p.message.textContent).toMatch(/2 files added/);
    // A drop on the marked area adds to the same list.
    let prevented = false;
    void p.drop.listeners["dragover"]!({ preventDefault: () => (prevented = true) });
    expect(prevented).toBe(true);
    void p.drop.listeners["drop"]!({
      preventDefault: () => undefined,
      dataTransfer: { files: [epub(3)] },
    });
    expect(p.rows().map(name)).toEqual(["book-1.epub", "book-2.epub", "book-3.epub"]);
    // Nothing is sent until Upload is pressed.
    expect(p.calls).toHaveLength(0);
    expect(FakeXhr.all).toHaveLength(0);
  });

  it("Adding more files adds to the list, and a file added twice shows once", async () => {
    const p = page([epub(1), epub(2)], []);
    p.pick([epub(2), epub(3)]);
    expect(p.rows().map(name)).toEqual(["book-1.epub", "book-2.epub", "book-3.epub"]);
    expect(p.message.textContent).toMatch(/1 file added/);
    expect(p.message.textContent).toMatch(/1 was already in the list/);
  });

  it("A row can be removed, and focus lands next to it", async () => {
    const p = page([epub(1), epub(2), epub(3)], []);
    await remove(p.rows()[1]!).listeners["click"]!();
    expect(p.rows().map(name)).toEqual(["book-1.epub", "book-3.epub"]);
    expect(p.message.textContent).toMatch(/Removed book-2.epub/);
    // The row that took its place has focus.
    expect(p.focused()).toBe(remove(p.rows()[1]!));
    // The last row's removal leaves focus on the one before.
    await remove(p.rows()[1]!).listeners["click"]!();
    expect(p.focused()).toBe(remove(p.rows()[0]!));
    // An empty list leaves focus on the file picker.
    await remove(p.rows()[0]!).listeners["click"]!();
    expect(p.rows()).toHaveLength(0);
    expect(p.focused()).toBe(p.input);
    expect(p.calls).toHaveLength(0);
  });

  it("A long list is sent in groups of 10, each confirmed before the next, with a fresh token", async () => {
    const files = Array.from({ length: 25 }, (_, i) => epub(i));
    const ids = (from: number, n: number) => ({
      uploads: Array.from({ length: n }, (_, i) => ({ id: `u${from + i}` })),
    });
    const p = page(files, [
      () => ({ status: 200, body: ids(0, 10) }),
      ...Array.from({ length: 10 }, () => () => ({ status: 200, body: { status: "queued" } })),
      () => ({ status: 200, body: ids(10, 10) }),
      ...Array.from({ length: 10 }, () => () => ({ status: 200, body: { status: "queued" } })),
      () => ({ status: 200, body: ids(20, 5) }),
      ...Array.from({ length: 5 }, () => () => ({ status: 200, body: { status: "queued" } })),
    ]);
    const clicked = p.click();
    const finishAll = async (from: number, n: number) => {
      for (let i = from; i < from + n; i++) {
        // Three at a time: each is started as another ends.
        while (FakeXhr.all.length <= i) await p.flush();
        done(FakeXhr.all[i]!);
        await p.flush();
      }
    };
    await p.flush();
    expect(sizesOf(p.calls[0]!.body)).toHaveLength(10);
    expect(p.calls[0]!.body?.get("cf-turnstile-response")).toBe("token-1");
    await finishAll(0, 10);
    for (let i = 0; i < 20 && p.calls.length < 12; i++) await p.flush();
    // The second ask comes only after the first ten were confirmed, with the next token.
    expect(p.calls.slice(1, 11).every((c) => c.url.endsWith("/complete"))).toBe(true);
    expect(sizesOf(p.calls[11]!.body)).toHaveLength(10);
    expect(p.calls[11]!.body?.get("cf-turnstile-response")).toBe("token-2");
    await finishAll(10, 10);
    for (let i = 0; i < 20 && p.calls.length < 23; i++) await p.flush();
    expect(sizesOf(p.calls[22]!.body)).toHaveLength(5);
    expect(p.calls[22]!.body?.get("cf-turnstile-response")).toBe("token-3");
    await finishAll(20, 5);
    await clicked;
    const asks = p.calls.filter((c) => c.url === "/uploads");
    expect(asks.map((c) => sizesOf(c.body)?.length)).toEqual([10, 10, 5]);
    expect(p.rows().every((r) => /Uploaded/.test(note(r)))).toBe(true);
  });

  it("The first group is announced as it starts, and a challenge as it appears", async () => {
    const p = page(
      [epub(1)],
      [
        () => ({ status: 200, body: { id: "up-1" } }),
        () => ({ status: 200, body: { status: "queued" } }),
      ],
    );
    const clicked = p.click();
    await p.flush();
    // Transfers are under way, and the live status already says so.
    expect(p.message.textContent).toBe("Sending 1 file.");
    // Turnstile asks for the person while the transfer is still running.
    p.interact();
    expect(p.message.textContent).toMatch(/needs you/);
    done(FakeXhr.all[0]!);
    await clicked;
  });

  it("A Turnstile check that needs the person is said aloud", async () => {
    const files = Array.from({ length: 11 }, (_, i) => epub(i));
    const p = page(files, [
      () => ({
        status: 200,
        body: { uploads: Array.from({ length: 10 }, (_, i) => ({ id: `u${i}` })) },
      }),
      ...Array.from({ length: 10 }, () => () => ({ status: 200, body: { status: "queued" } })),
      () => ({ status: 200, body: { id: "last" } }),
      () => ({ status: 200, body: { status: "queued" } }),
    ]);
    // The check after the first ask is slow.
    p.turnstile.slowBy = 1000000;
    const clicked = p.click();
    for (let i = 0; i < 10; i++) {
      while (FakeXhr.all.length <= i) await p.flush();
      done(FakeXhr.all[i]!);
      await p.flush();
    }
    for (let i = 0; i < 5; i++) await p.flush();
    expect(p.calls).toHaveLength(11);
    // Turnstile calls the page back when it needs the person.
    p.interact();
    for (let i = 0; i < 5; i++) await p.flush();
    expect(p.message.textContent).toMatch(/needs you/);
    // Once it passes, the page goes on with no click.
    p.turnstile.waiting = 0;
    while (FakeXhr.all.length < 11) await p.flush();
    done(FakeXhr.all[10]!);
    await clicked;
    expect(sizesOf(p.calls[11]!.body)).toHaveLength(1);
    expect(note(p.rows()[10]!)).toMatch(/Uploaded/);
  });

  it("A daily quota that runs out partway keeps what was sent", async () => {
    const files = Array.from({ length: 15 }, (_, i) => epub(i));
    const p = page(files, [
      () => ({
        status: 200,
        body: { uploads: Array.from({ length: 10 }, (_, i) => ({ id: `u${i}` })) },
      }),
      ...Array.from({ length: 10 }, () => () => ({ status: 200, body: { status: "queued" } })),
      () => ({ status: 429, body: { error: "You have no uploads left today." } }),
      () => ({
        status: 200,
        body: { uploads: Array.from({ length: 5 }, (_, i) => ({ id: `v${i}` })) },
      }),
      ...Array.from({ length: 5 }, () => () => ({ status: 200, body: { status: "queued" } })),
    ]);
    const clicked = p.click();
    for (let i = 0; i < 10; i++) {
      while (FakeXhr.all.length <= i) await p.flush();
      done(FakeXhr.all[i]!);
      await p.flush();
    }
    await clicked;
    expect(p.message.textContent).toBe("You have no uploads left today.");
    expect(
      p
        .rows()
        .slice(0, 10)
        .every((r) => /Uploaded/.test(note(r))),
    ).toBe(true);
    expect(p.rows().slice(10).map(note)).toEqual(
      Array(5).fill(expect.stringMatching(/Not uploaded.*stays in the list/)),
    );
    expect(p.rows()).toHaveLength(15);
    expect(p.button.disabled).toBe(false);

    // Another click sends only the five.
    const again = p.click();
    await p.flush();
    expect(sizesOf(p.calls[p.calls.length - 1]!.body)).toHaveLength(5);
    for (let i = 10; i < 15; i++) {
      while (FakeXhr.all.length <= i) await p.flush();
      done(FakeXhr.all[i]!);
      await p.flush();
    }
    await again;
    expect(p.rows().every((r) => /Uploaded/.test(note(r)))).toBe(true);
  });

  it("A fresh token that never arrives leaves the rest in the list, and says so", async () => {
    const files = Array.from({ length: 11 }, (_, i) => epub(i));
    const p = page(files, [
      () => ({
        status: 200,
        body: { uploads: Array.from({ length: 10 }, (_, i) => ({ id: `u${i}` })) },
      }),
      ...Array.from({ length: 10 }, () => () => ({ status: 200, body: { status: "queued" } })),
    ]);
    p.turnstile.slowBy = 1000000000;
    const clicked = p.click();
    for (let i = 0; i < 10; i++) {
      while (FakeXhr.all.length <= i) await p.flush();
      done(FakeXhr.all[i]!);
      await p.flush();
    }
    await clicked;
    expect(p.message.textContent).toMatch(/didn't finish/);
    expect(note(p.rows()[10]!)).toMatch(/Not uploaded.*stays in the list/);
    expect(p.calls.filter((c) => c.url === "/uploads")).toHaveLength(1);
  });

  it("A rate limit that clears within a minute is waited out", async () => {
    const files = Array.from({ length: 11 }, (_, i) => epub(i));
    const p = page(files, [
      () => ({
        status: 200,
        body: { uploads: Array.from({ length: 10 }, (_, i) => ({ id: `u${i}` })) },
      }),
      ...Array.from({ length: 10 }, () => () => ({ status: 200, body: { status: "queued" } })),
      () => ({ status: 429, body: { error: "Too fast.", retryAfter: 60 } }),
      () => ({ status: 200, body: { id: "last" } }),
      () => ({ status: 200, body: { status: "queued" } }),
    ]);
    const clicked = p.click();
    for (let i = 0; i < 10; i++) {
      while (FakeXhr.all.length <= i) await p.flush();
      done(FakeXhr.all[i]!);
      await p.flush();
    }
    for (let i = 0; i < 10; i++) await p.flush();
    expect(p.message.textContent).toMatch(/Pausing 60 seconds/);
    // Nothing more is asked until the wait is over.
    expect(p.calls.filter((c) => c.url === "/uploads")).toHaveLength(2);
    p.timers.find((t) => t.ms === 61000)!.fire();
    while (FakeXhr.all.length < 11) await p.flush();
    done(FakeXhr.all[10]!);
    await clicked;
    // The same group is asked again, with a fresh token.
    const asks = p.calls.filter((c) => c.url === "/uploads");
    expect(asks).toHaveLength(3);
    expect(asks[2]!.body?.get("cf-turnstile-response")).toBe("token-3");
    expect(note(p.rows()[10]!)).toMatch(/Uploaded/);
  });

  it("The summary doesn't say everything was sent when a file failed", async () => {
    const p = page(
      [epub(1), epub(2)],
      [
        () => ({ status: 200, body: { uploads: [{ id: "a" }, { id: "b" }] } }),
        () => ({ status: 200, body: { status: "queued" } }),
      ],
    );
    const clicked = p.click();
    await p.flush();
    done(FakeXhr.all[0]!);
    FakeXhr.all[1]!.onerror!();
    await clicked;
    expect(p.message.textContent).toBe("1 of 2 files sent. Press Upload to try the rest.");
  });
});

// A zip built by hand: entries stored or deflated, with the size the directory claims for each.
type ZipEntry = { name: string; data: Buffer; method?: 0 | 8; claims?: number };
const zipOf = (entries: ZipEntry[], zipName = "books.zip") => {
  const parts: Buffer[] = [];
  const directory: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const method = entry.method ?? 8;
    const entryName = Buffer.from(entry.name);
    const body = method === 8 ? deflateRawSync(entry.data) : entry.data;
    const claims = entry.claims ?? entry.data.length;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(claims, 22);
    local.writeUInt16LE(entryName.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(claims, 24);
    central.writeUInt16LE(entryName.length, 28);
    central.writeUInt32LE(offset, 42);
    parts.push(local, entryName, body);
    directory.push(central, entryName);
    offset += local.length + entryName.length + body.length;
  }
  const dir = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return new File([Buffer.concat([...parts, dir, end])], zipName);
};
const book = (bookName: string, bytes: number): ZipEntry => ({
  name: bookName,
  data: Buffer.alloc(bytes, 7),
});
const MB = 1024 * 1024;

describe("26-bulk-zip-upload", () => {
  it("Zip of epubs adds each epub to the list", async () => {
    const p = page(
      [],
      [
        () => ({ status: 200, body: { uploads: [{ id: "a" }, { id: "b" }] } }),
        () => ({ status: 200, body: { status: "queued" } }),
        () => ({ status: 200, body: { status: "queued" } }),
      ],
    );
    p.pick([zipOf([book("one.epub", 300), book("two.epub", 5000)])]);
    await vi.waitFor(() => expect(p.rows()).toHaveLength(2));
    expect(p.rows().map(name)).toEqual(["one.epub", "two.epub"]);
    expect(p.rows().map(size)).toEqual(["(300 B) ", "(5 KB) "]);
    expect(p.message.textContent).toMatch(/2 epubs added from books\.zip/);
    // Nothing is sent until Upload; then each goes through the normal ask, as its own file.
    expect(p.calls).toHaveLength(0);
    const clicked = p.click();
    await p.flush();
    expect(sizesOf(p.calls[0]!.body)).toEqual(["300", "5000"]);
    expect(FakeXhr.all.map((x) => [x.url, x.sent?.name, x.sent?.size])).toEqual([
      ["/uploads/a", "one.epub", 300],
      ["/uploads/b", "two.epub", 5000],
    ]);
    expect(FakeXhr.all[0]!.headers).toEqual({ "Content-Type": "application/epub+zip" });
    for (const xhr of FakeXhr.all) done(xhr);
    await clicked;
  });

  it("A zip dropped on the area is read like a picked one", async () => {
    const p = page([], []);
    void p.drop.listeners["drop"]!({
      preventDefault: () => undefined,
      dataTransfer: { files: [zipOf([book("dropped.epub", 10)])] },
    });
    await vi.waitFor(() => expect(p.rows().map(name)).toEqual(["dropped.epub"]));
  });

  it("Each epub in the zip gets its own status", async () => {
    const p = page(
      [],
      [
        () => ({ status: 200, body: { uploads: [{ id: "a" }, { id: "b" }] } }),
        () => ({ status: 200, body: { status: "queued" } }),
        () => ({ status: 200, body: { status: "duplicate" } }),
      ],
    );
    p.pick([zipOf([book("one.epub", 300), book("two.epub", 400)])]);
    await vi.waitFor(() => expect(p.rows()).toHaveLength(2));
    const clicked = p.click();
    await p.flush();
    for (const xhr of FakeXhr.all) done(xhr);
    await clicked;
    expect(p.rows().map(note)).toEqual([
      expect.stringMatching(/Uploaded/),
      expect.stringMatching(/already/),
    ]);
  });

  it("Zip over 100 MB is refused before it is read", async () => {
    const huge = {
      name: "huge.zip",
      size: 100 * MB + 1,
      slice: () => {
        throw new Error("read");
      },
    };
    const p = page([huge], []);
    await vi.waitFor(() => expect(p.message.textContent).toMatch(/100 MB/));
    expect(p.message.textContent).toContain("huge.zip");
    expect(p.rows()).toHaveLength(0);
  });

  it("The 25 MB limit applies to each epub inside", async () => {
    const p = page([], []);
    p.pick([
      zipOf([
        { name: "large.epub", data: Buffer.from("x"), claims: 26 * MB },
        book("fine.epub", 100),
      ]),
    ]);
    await vi.waitFor(() => expect(p.rows()).toHaveLength(2));
    expect(p.rows().map(name)).toEqual(["large.epub", "fine.epub"]);
    expect(p.rows().map(note)).toEqual([expect.stringMatching(/Over the 25 MB limit/), ""]);
  });

  it("An entry that expands past the limit stops being read", async () => {
    // Says 100 bytes, holds 120 MB of the same byte, which deflates to a tiny entry.
    let seen = 0;
    class Counting {
      readable: ReadableStream;
      writable: WritableStream;
      constructor(format: "deflate-raw") {
        const inflate = new DecompressionStream(format);
        const count = new TransformStream({
          transform(chunk: Uint8Array, out) {
            seen += chunk.length;
            out.enqueue(chunk);
          },
        });
        this.writable = inflate.writable;
        this.readable = inflate.readable.pipeThrough(count);
      }
    }
    const p = page([], [], { DecompressionStream: Counting });
    p.pick([zipOf([{ name: "bomb.epub", data: Buffer.alloc(120 * MB, 7), claims: 100 }])]);
    await vi.waitFor(() => expect(p.rows()).toHaveLength(1), { timeout: 10000 });
    expect(note(p.rows()[0]!)).toMatch(/Over the 25 MB limit/);
    expect(seen).toBeLessThan(60 * MB);
  });

  it("Folders are searched and other files are shown as skipped", async () => {
    const p = page([], []);
    p.pick([
      zipOf([
        { name: "stories/", data: Buffer.alloc(0), method: 0 },
        book("stories/deep/a.epub", 100),
        book("notes.txt", 50),
        { name: "more.zip", data: Buffer.from("not opened"), method: 0 },
        book("b.EPUB", 200),
      ]),
    ]);
    await vi.waitFor(() => expect(p.rows()).toHaveLength(4));
    expect(p.rows().map(name)).toEqual(["a.epub", "notes.txt", "more.zip", "b.EPUB"]);
    expect(p.rows().map(note)).toEqual([
      "",
      expect.stringMatching(/Skipped.*not an epub/),
      expect.stringMatching(/Skipped.*zip inside a zip/),
      "",
    ]);
    expect(p.message.textContent).toMatch(/2 epubs added.*2 skipped/);
    // Skipped rows are never sent.
    void p.click();
    await p.flush();
    expect(sizesOf(p.calls[0]!.body)).toEqual(["100", "200"]);
  });

  it("A zip with no epubs adds nothing", async () => {
    const p = page([], []);
    p.pick([zipOf([book("notes.txt", 50)])]);
    await vi.waitFor(() => expect(p.message.textContent).toMatch(/no epub/));
    expect(p.rows()).toHaveLength(0);
  });

  it("A file that isn't a valid zip adds nothing", async () => {
    const p = page([], []);
    p.pick([new File([Buffer.alloc(400, 9)], "broken.zip")]);
    await vi.waitFor(() => expect(p.message.textContent).toMatch(/isn't a valid zip/));
    expect(p.rows()).toHaveLength(0);
  });

  it("Epubs past the remaining daily quota stay listed", async () => {
    const entries = Array.from({ length: 12 }, (_, i) => book(`book-${i}.epub`, 100 + i));
    const p = page(
      [],
      [
        () => ({
          status: 200,
          body: { uploads: Array.from({ length: 10 }, (_, i) => ({ id: `u${i}` })) },
        }),
        ...Array.from({ length: 10 }, () => () => ({ status: 200, body: { status: "queued" } })),
        () => ({ status: 429, body: { error: "You have no uploads left today." } }),
      ],
    );
    p.pick([zipOf(entries)]);
    await vi.waitFor(() => expect(p.rows()).toHaveLength(12));
    const clicked = p.click();
    for (let i = 0; i < 10; i++) {
      while (FakeXhr.all.length <= i) await p.flush();
      done(FakeXhr.all[i]!);
      await p.flush();
    }
    await clicked;
    expect(
      p
        .rows()
        .slice(0, 10)
        .every((r) => /Uploaded/.test(note(r))),
    ).toBe(true);
    expect(p.rows().slice(10).map(note)).toEqual([
      expect.stringMatching(/Not uploaded.*stays in the list/),
      expect.stringMatching(/Not uploaded.*stays in the list/),
    ]);
  });

  it("A browser without built-in decompression is told to upload the epubs directly", async () => {
    const p = page([], [], { DecompressionStream: undefined });
    p.pick([zipOf([book("one.epub", 100)])]);
    await vi.waitFor(() => expect(p.message.textContent).toMatch(/upload the epubs directly/));
    expect(p.rows()).toHaveLength(0);
  });
});
