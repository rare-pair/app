/** The largest `works.ao3_work_id`: an int4. */
export const MAX_INT4 = 2_147_483_647;

/**
 * The AO3 work ID as the int4 `works` keys on, or null when it isn't one: digits only, no
 * leading zero (so "007" is not work 7), not zero, not past an int4. The takedown check and
 * the save both read an ID through this, so they never disagree on which work a file is.
 */
export function parseWorkId(id: string): number | null {
  if (!/^[1-9]\d{0,9}$/.test(id)) return null;
  const n = Number(id);
  return n <= MAX_INT4 ? n : null;
}
