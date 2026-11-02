import type { UploadStatus } from "@archive/db";
import { runInNewContext, Script } from "node:vm";
import { describe, expect, it } from "vitest";
import { MY_UPLOADS_SCRIPT } from "../src/my-uploads-script";
import { badgeLabel, inProgress } from "../src/upload-badge";

// The My uploads script, run over hand-written fakes for the page, `fetch` and timers.
// Real DOM and real timers are not covered: the Worker tests check the markup it reads.

class FakeEl {
  attrs = new Map<string, string>();
  textContent = "";
  children: FakeEl[] = [];
  constructor(
    public tag: string,
    private slots: Record<string, FakeEl> = {},
  ) {}
  setAttribute(name: string, value: string) {
    this.attrs.set(name, value);
  }
  getAttribute(name: string) {
    return this.attrs.get(name) ?? null;
  }
  removeAttribute(name: string) {
    this.attrs.delete(name);
  }
  querySelector(selector: string) {
    if (selector === "a") return this.children.find((c) => c.tag === "a") ?? null;
    return this.slots[selector] ?? null;
  }
  append(child: FakeEl) {
    this.children.push(child);
  }
}

/** A row as the server renders it: id, status, the polling flag, name slot and badge. */
function row(id: string, status: string, polling = true) {
  const badge = new FakeEl("span");
  const name = new FakeEl("span");
  name.textContent = "Upload of 2026-03-04 05:06 UTC";
  const li = new FakeEl("li", { ".badge": badge, ".upload-name": name });
  li.setAttribute("data-upload-id", id);
  li.setAttribute("data-status", status);
  if (polling) li.setAttribute("data-polling", "");
  return { li, badge, name };
}

type Task = () => Promise<void> | void;
type Reply = { status: number; body?: object } | "throw";

function page(rows: ReturnType<typeof row>[], replies: Record<string, Reply[]>) {
  const fetched: string[] = [];
  const timers: Array<Task> = [];
  const listeners: Record<string, Array<Task>> = {};
  const state = { reloads: 0, hidden: false };
  const document = {
    get hidden() {
      return state.hidden;
    },
    querySelectorAll: (selector: string) => {
      expect(selector).toBe("li[data-upload-id][data-polling]");
      return rows.flatMap((r) => (r.li.getAttribute("data-polling") !== null ? [r.li] : []));
    },
    createElement: (tag: string) => new FakeEl(tag),
    addEventListener: (type: string, fn: Task) => {
      (listeners[type] ??= []).push(fn);
    },
  };
  const fetch = async (url: string) => {
    fetched.push(url);
    const reply = replies[url]?.shift();
    if (reply === undefined || reply === "throw") throw new Error("network");
    return {
      ok: reply.status >= 200 && reply.status < 300,
      status: reply.status,
      json: async () => reply.body,
    };
  };
  runInNewContext(MY_UPLOADS_SCRIPT, {
    document,
    fetch,
    setTimeout: (fn: Task) => timers.push(fn),
    clearTimeout: () => {},
    AbortSignal,
    location: {
      reload: () => {
        state.reloads++;
      },
    },
  });
  return {
    fetched,
    timers,
    state,
    /** Runs the oldest queued timer and waits for its polls to finish. */
    tick: async () => {
      await timers.shift()?.();
    },
    visibilitychange: async () => {
      for (const fn of listeners.visibilitychange ?? []) await fn();
    },
  };
}

const ID_A = "11111111-1111-4111-8111-111111111111";
const ID_B = "22222222-2222-4222-8222-222222222222";

describe("03-upload-status: My uploads updates in place with JS", () => {
  it("The script is valid JavaScript", () => {
    expect(() => new Script(MY_UPLOADS_SCRIPT)).not.toThrow();
  });

  it("A processing upload's badge becomes Live without a reload when its status changes", async () => {
    const a = row(ID_A, "processing");
    const p = page([a], {
      [`/uploads/${ID_A}`]: [
        { status: 200, body: { id: ID_A, status: "processing", work: null } },
        { status: 200, body: { id: ID_A, status: "live", work: { id: "w", url: "/works/16200" } } },
      ],
    });

    await p.tick();
    expect(a.badge.textContent).toBe("Processing");
    await p.tick();

    expect(a.badge.textContent).toBe("Live");
    expect(a.li.getAttribute("data-status")).toBe("live");
    expect(p.state.reloads).toBe(0);
    expect(p.fetched).toEqual([`/uploads/${ID_A}`, `/uploads/${ID_A}`]);
  });

  it("A row that goes live gets a View the work link in its name slot", async () => {
    const a = row(ID_A, "processing");
    const p = page([a], {
      [`/uploads/${ID_A}`]: [
        { status: 200, body: { status: "live", work: { id: "w", url: "/works/16200" } } },
      ],
    });

    await p.tick();

    const link = a.name.children[0];
    expect(link?.tag).toBe("a");
    expect(link?.getAttribute("href")).toBe("/works/16200");
    expect(link?.textContent).toBe("View the work");
    expect(a.name.textContent).toBe("");
  });

  it("A work url that is not a /works/ path is not made a link", async () => {
    for (const url of ["javascript:alert(1)", "//evil.test/works/1", "/works/1/x", "/works/0"]) {
      const a = row(ID_A, "processing");
      const p = page([a], {
        [`/uploads/${ID_A}`]: [{ status: 200, body: { status: "live", work: { id: "w", url } } }],
      });
      await p.tick();
      expect(a.name.children).toEqual([]);
    }
  });

  it("Polls only the rows marked data-polling, and stops once every row has left progress", async () => {
    const a = row(ID_A, "processing");
    const idle = row(ID_B, "pending", false);
    const p = page([a, idle], {
      [`/uploads/${ID_A}`]: [{ status: 200, body: { status: "live", work: null } }],
    });
    expect(p.timers).toHaveLength(1);

    await p.tick();

    expect(p.fetched).toEqual([`/uploads/${ID_A}`]);
    expect(p.timers).toHaveLength(0);
  });

  it("Sets no timer and fetches nothing when no row is polled", () => {
    const p = page([row(ID_A, "live", false)], {});
    expect(p.timers).toHaveLength(0);
    expect(p.fetched).toEqual([]);
  });

  it("A confirmed pending upload reads Processing, and stays polled", async () => {
    const a = row(ID_A, "pending");
    const p = page([a], {
      [`/uploads/${ID_A}`]: [{ status: 200, body: { status: "pending", work: null } }],
    });

    await p.tick();

    expect(a.badge.textContent).toBe("Processing");
    expect(p.timers).toHaveLength(1);
  });

  it("Keeps polling after a network error or a 5xx", async () => {
    const a = row(ID_A, "processing");
    const p = page([a], { [`/uploads/${ID_A}`]: ["throw", { status: 503 }] });

    await p.tick();
    expect(p.timers).toHaveLength(1);
    await p.tick();

    expect(p.timers).toHaveLength(1);
    expect(a.badge.textContent).toBe("");
  });

  it("Drops a row that answers 404 and keeps polling the others", async () => {
    const a = row(ID_A, "processing");
    const b = row(ID_B, "processing");
    const p = page([a, b], {
      [`/uploads/${ID_A}`]: [{ status: 404 }],
      [`/uploads/${ID_B}`]: [
        { status: 200, body: { status: "processing", work: null } },
        { status: 200, body: { status: "processing", work: null } },
      ],
    });

    await p.tick();
    await p.tick();

    expect(p.fetched).toEqual([`/uploads/${ID_A}`, `/uploads/${ID_B}`, `/uploads/${ID_B}`]);
  });

  it("Reloads the page and stops polling when the session has ended (401)", async () => {
    const p = page([row(ID_A, "processing")], { [`/uploads/${ID_A}`]: [{ status: 401 }] });

    await p.tick();

    expect(p.state.reloads).toBe(1);
    expect(p.timers).toHaveLength(0);
  });

  it("Does not poll while the tab is hidden, and polls again when it is visible", async () => {
    const a = row(ID_A, "processing");
    const p = page([a], {
      [`/uploads/${ID_A}`]: [{ status: 200, body: { status: "live", work: null } }],
    });
    p.state.hidden = true;

    await p.tick();
    expect(p.fetched).toEqual([]);
    expect(p.timers).toHaveLength(0);

    p.state.hidden = false;
    await p.visibilitychange();

    expect(p.fetched).toEqual([`/uploads/${ID_A}`]);
    expect(a.badge.textContent).toBe("Live");
  });

  it("Ignores a reply without a status string", async () => {
    const a = row(ID_A, "processing");
    const p = page([a], { [`/uploads/${ID_A}`]: [{ status: 200, body: { status: 7 } }] });

    await p.tick();

    expect(a.badge.textContent).toBe("");
    expect(p.timers).toHaveLength(1);
  });

  it("Every status reads as the server's label for a confirmed upload", async () => {
    const statuses: UploadStatus[] = [
      "pending",
      "processing",
      "live",
      "held_for_review",
      "duplicate",
      "over_quota",
      "parse_failed",
      "not_ao3",
    ];
    for (const status of statuses) {
      const a = row(ID_A, "processing");
      const p = page([a], {
        [`/uploads/${ID_A}`]: [{ status: 200, body: { status, work: null } }],
      });
      await p.tick();
      expect(a.badge.textContent).toBe(badgeLabel(status, true));
      // The script keeps polling exactly the rows the server calls in progress.
      expect(p.timers).toHaveLength(inProgress(status, true) ? 1 : 0);
    }
  });
});
