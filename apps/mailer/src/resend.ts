import type { OutgoingEmail, SendResult, Sender } from "./sender";

const BATCH_URL = "https://api.resend.com/emails/batch";

// One consumer runs at a time (max_concurrency 1), so a call that hangs would hold up every
// sign-in email behind it.
const TIMEOUT_MS = 10_000;

// The provider message IDs from an accepted batch's answer. These are logged, so anything that
// doesn't look like an ID (Resend's are UUIDs) is left out rather than trusted.
// oxlint-disable-next-line deslop/no-unknown-parameters -- the raw answer body; checking it is this function's job
function messageIds(body: unknown): string[] {
  // SAFETY: the optional chain reads `data` off any value, and the next line checks it.
  const data = (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return [];
  // Unknown, not the any[] Array.isArray gives, so each entry stays checked.
  const entries: unknown[] = data;
  return entries.flatMap((d) => {
    // SAFETY: the same for each entry's `id`, which the next line checks.
    const id = (d as { id?: unknown } | null)?.id;
    // oxlint-disable-next-line deslop/no-runtime-typeof -- how an untrusted id is checked before it is logged
    return typeof id === "string" && /^[\w-]{1,64}$/.test(id) ? [id] : [];
  });
}

// The request indexes of the emails a permissive batch dropped, from `errors[].index`. Only the
// index is read: `errors[].message` may echo the address, so it is never touched.
// oxlint-disable-next-line deslop/no-unknown-parameters -- the raw answer body; checking it is this function's job
function rejectedIndexes(body: unknown, count: number): number[] {
  // SAFETY: the optional chain reads `errors` off any value, and the next line checks it.
  const errors = (body as { errors?: unknown } | null)?.errors;
  if (!Array.isArray(errors)) return [];
  const entries: unknown[] = errors;
  const indexes = entries.flatMap((e) => {
    // SAFETY: the same for each entry's `index`, which the next lines check.
    const index = (e as { index?: unknown } | null)?.index;
    // oxlint-disable-next-line deslop/no-runtime-typeof -- how an untrusted index is checked before it is used
    return typeof index === "number" && Number.isInteger(index) && index >= 0 && index < count
      ? [index]
      : [];
  });
  return [...new Set(indexes)];
}

// Resend's batch API: one call for up to 100 emails. In permissive mode a bad email is dropped
// and reported in `errors` instead of failing the whole call (resend-node's batch types; the
// API reference doesn't document it).
// https://resend.com/docs/api-reference/emails/send-batch-emails
export function resendSender(
  apiKey: string,
  fetcher: typeof fetch = (...a) => fetch(...a),
  timeoutMs = TIMEOUT_MS,
): Sender {
  return {
    name: "resend",
    async sendBatch(emails: OutgoingEmail[]): Promise<SendResult> {
      let res: Response;
      try {
        res = await fetcher(BATCH_URL, {
          method: "POST",
          headers: {
            authorization: `Bearer ${apiKey}`,
            "content-type": "application/json",
            "x-batch-validation": "permissive",
          },
          body: JSON.stringify(emails),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch {
        // A network error or a timeout is an outage. The error is dropped: it may echo the request.
        return { outcome: "refused", status: 0 };
      }
      if (res.ok) {
        // Accepted, so it is sent even when the answer can't be read: retrying would send it twice.
        const body: unknown = await res.json().catch(() => null);
        const rejected = rejectedIndexes(body, emails.length);
        return rejected.length > 0
          ? { outcome: "sent", ids: messageIds(body), rejected }
          : { outcome: "sent", ids: messageIds(body) };
      }
      // The body is never read on failure: providers echo the recipient in error messages.
      await res.body?.cancel().catch(() => {});
      // A refusal is a rate limit, a quota (both 429) or an outage (5xx).
      // https://resend.com/docs/api-reference/errors
      if (res.status === 429 || res.status >= 500)
        return { outcome: "refused", status: res.status };
      return { outcome: "failed", status: res.status };
    },
  };
}
