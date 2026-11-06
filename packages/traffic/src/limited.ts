/** What a Workers rate-limiting binding is, to this package: it has no Workers types. */
type Limiter = { limit(options: { key: string }): Promise<{ success: boolean }> };

/**
 * Whether `key` is over its limit in the current window. When the binding fails the request
 * goes through: the binding's counts are approximate and only meant to slow abuse
 * (ARCHITECTURE, Surge controls), so its outage mustn't take a route down with it. Only the error's name is logged, since the
 * message could carry the key. A binding missing from the config is a mistake, not an
 * outage, so it throws rather than quietly turning the limit off.
 */
export async function isLimited(limiter: Limiter | undefined, key: string): Promise<boolean> {
  if (limiter === undefined) throw new Error("Rate limit binding missing");
  try {
    return !(await limiter.limit({ key })).success;
  } catch (error) {
    console.error(`Rate limit unavailable: ${error instanceof Error ? error.name : "Error"}`);
    return false;
  }
}
