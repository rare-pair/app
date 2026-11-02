/**
 * The image keys `html` references under AO3 work `ao3WorkId`'s `img/` prefix: every
 * `/works/<ao3WorkId>/img/<64 lowercase hex>` path in it, whatever the origin before it, so a
 * changed content origin doesn't un-reference anything. Another work's images don't count.
 */
export function imageRefs(html: string, ao3WorkId: number): Set<string> {
  const path = new RegExp(`/works/${ao3WorkId}/img/([0-9a-f]{64})(?![0-9a-f])`, "g");
  const keys = new Set<string>();
  for (const match of html.matchAll(path)) {
    // SAFETY: the pattern's one group always takes part in a match.
    keys.add(match[1] as string);
  }
  return keys;
}
