import type { EmailMessage } from "./message";

export const BULK_QUEUE = "email-bulk";

/** The kinds each queue carries (ARCHITECTURE, Auth, Email: Two queues). */
function kindsOn(queue: string): readonly EmailMessage["kind"][] {
  switch (queue) {
    case "email":
      return ["sign-in", "waitlist-confirm", "removal-confirm"];
    case BULK_QUEUE:
      return ["waitlist-launch"];
    default:
      return [];
  }
}

/**
 * The parsed message, or null if its kind belongs on the other queue: that is refused like any
 * other bad body. The launch email is sent only from `email-bulk`, where it is paced.
 */
export function acceptedOn(queue: string, message: EmailMessage | null): EmailMessage | null {
  return message !== null && kindsOn(queue).includes(message.kind) ? message : null;
}
