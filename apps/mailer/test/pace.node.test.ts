import { describe, expect, it } from "vitest";
import { bulkIntervalMs, pace } from "../src/pace";

// A clock the test moves: sleeping advances it, and a send takes `callMs`.
function fakeClock() {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe("22-waitlist", () => {
  it("The launch send is spread out", async () => {
    const clock = fakeClock();
    const intervalMs = 10_000;
    const startedAt: number[] = [];

    // Five full batches of 50 back to back, as a backlog delivers them: each takes 400 ms to send.
    for (let batch = 0; batch < 5; batch++) {
      const began = clock.now();
      startedAt.push(began);
      clock.advance(400);
      await pace(began, intervalMs, clock.now, clock.sleep);
    }

    // No two sends start closer than the interval, so no more than 50 emails go in any 10 s.
    const gaps = startedAt.slice(1).map((t, i) => t - startedAt[i]!);
    expect(gaps).toEqual([10_000, 10_000, 10_000, 10_000]);
  });

  it("does not wait when a send already took longer than the interval", async () => {
    const clock = fakeClock();

    clock.advance(12_000);
    await pace(0, 10_000, clock.now, clock.sleep);

    expect(clock.now()).toBe(12_000);
  });
});

describe("bulkIntervalMs", () => {
  it.each([
    ["10", 10_000],
    ["2.5", 2_500],
    ["0", 0],
    // Capped at 300 s, not sent faster.
    ["3600", 300_000],
  ])("reads %s seconds as %i ms", (value, ms) => {
    expect(bulkIntervalMs(value)).toBe(ms);
  });

  // A missing or misspelt setting must not turn the pacing off.
  it.each([undefined, "", "soon", "-5", "NaN", "Infinity"])(
    "falls back to the default for %s",
    (value) => {
      expect(bulkIntervalMs(value)).toBe(10_000);
    },
  );
});
