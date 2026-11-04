/** A Postgres error's SQLSTATE, or null. pg's errors carry it as `code`. */
// oxlint-disable-next-line deslop/no-unknown-parameters -- a caught value is unknown by contract
export function sqlState(error: unknown): string | null {
  if (!(error instanceof Error) || !("code" in error)) return null;
  const code = String(error.code);
  return /^[0-9A-Z]{5}$/.test(code) ? code : null;
}

/**
 * Whether a SQLSTATE says the data was refused, not the database: a cardinality violation, a
 * data exception (a NUL byte, a bad encoding), an integrity violation or a program limit.
 * The same bytes fail the same way every time, so a retry can't help.
 */
export function isDataErrorState(state: string | null): boolean {
  return state !== null && /^(21|22|23|54)/.test(state);
}
