import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_FLOOR_MS, floorOf, padTo } from "../src/floor";

// Runs in the "node" project with fake timers: the floor's timing, without waiting it out.
// The workerd tests check the Worker's answers against the floor with a real, short one.

/** Resolves to whether `promise` has settled, after the microtasks queued so far. */
async function settled(promise: Promise<unknown>) {
  let done = false;
  promise.then(
    () => (done = true),
    () => (done = true),
  );
  await vi.advanceTimersByTimeAsync(0);
  return done;
}

describe("floorOf", () => {
  it("reads a whole number of milliseconds, and keeps the default when the var is missing or not one", () => {
    expect(floorOf("300")).toBe(300);
    expect(floorOf("1")).toBe(1);
    expect(floorOf("30000")).toBe(30_000);
    for (const bad of [
      undefined,
      "",
      "soon",
      "-5",
      "1.5",
      "NaN",
      "0",
      "00",
      "30001",
      "3000000000",
    ]) {
      expect(floorOf(bad), String(bad)).toBe(DEFAULT_FLOOR_MS);
    }
  });
});

describe("padTo", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("answers a quick job only once the floor has passed", async () => {
    const answer = padTo(1000, async () => "done");

    await vi.advanceTimersByTimeAsync(999);
    expect(await settled(answer)).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(await answer).toBe("done");
  });

  it("adds no wait to a job slower than the floor", async () => {
    const answer = padTo(
      1000,
      () => new Promise<string>((resolve) => setTimeout(resolve, 1500, "slow")),
    );

    await vi.advanceTimersByTimeAsync(1499);
    expect(await settled(answer)).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(await answer).toBe("slow");
  });

  it("rethrows a failing job's error only after the floor, so a failure is no faster", async () => {
    const answer = padTo(1000, async () => {
      throw new Error("job failed");
    });
    // Handled from the start, so the rejection is never reported as unhandled while waiting.
    const outcome = expect(answer).rejects.toThrow("job failed");

    await vi.advanceTimersByTimeAsync(999);
    expect(await settled(answer)).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await outcome;
  });
});
