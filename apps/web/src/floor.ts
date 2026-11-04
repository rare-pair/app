/** Used when `WAITLIST_FLOOR_MS` is missing or misspelt: a bad var never turns the floor off. */
export const DEFAULT_FLOOR_MS = 2000;

/** The longest floor accepted: a longer one would overflow setTimeout and fire at once. */
const MAX_FLOOR_MS = 30_000;

/**
 * A floor var's value in milliseconds: a whole number from 1 to 30000, or else the default,
 * so a zero or a typo can't turn the floor off.
 */
export function floorOf(raw: string | undefined): number {
  const ms = raw !== undefined && /^\d+$/.test(raw) ? Number(raw) : 0;
  return ms >= 1 && ms <= MAX_FLOOR_MS ? ms : DEFAULT_FLOOR_MS;
}

/**
 * Runs `work` and answers with its result no sooner than `floorMs` after the call, whether it
 * returns or throws. The timer runs beside the work, not after it: workerd's clock only
 * advances at I/O, so a "time left" worked out from `Date.now()` could read zero after
 * CPU-only work. A floor can't hide a job slower than itself, so it must be set above the
 * slowest path.
 */
export async function padTo<T>(floorMs: number, work: () => Promise<T>): Promise<T> {
  const floor = new Promise<void>((resolve) => setTimeout(resolve, floorMs));
  try {
    return await work();
  } finally {
    // Also when `work` throws: a failure is no faster than a success.
    await floor;
  }
}
