import type { Site } from "./site";

/**
 * Waits up to 10 seconds for the newest removal confirmation email to `email`, and returns its
 * link. The email names no work: one address asking twice gets a link for each.
 */
export async function removalLink(site: Site, email: string): Promise<string> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const sent = (await site.emails()).filter(
      (m) => m.kind === "removal-confirm" && m.to === email,
    );
    const last = sent.at(-1);
    if (last !== undefined) return last.url;
    if (Date.now() > deadline) throw new Error(`no removal email to ${email} in 10 seconds`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
