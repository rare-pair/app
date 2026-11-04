// An email ready for a provider: the mailer has rendered it and set `from`.
export interface OutgoingEmail {
  from: string;
  to: string;
  subject: string;
  text: string;
  // Extra message headers. Only the launch email sets any (one-click unsubscribe, RFC 8058).
  headers?: Record<string, string>;
}

// What a provider made of one batch call.
// - sent: accepted; `ids` are the provider's message IDs of the emails it took. `rejected` holds
//   the indexes of emails it dropped from an otherwise accepted batch (a bad address): those
//   are not sent, and no other provider is tried for them. Absent when there are none.
// - refused: rate limit, quota or outage. Another provider may take the batch.
// - failed: anything else (a bad request, a bad key). Another provider would fare no better.
export type SendResult =
  | { outcome: "sent"; ids: string[]; rejected?: number[] }
  | { outcome: "refused"; status: number }
  | { outcome: "failed"; status: number };

export interface Sender {
  readonly name: string;
  sendBatch(emails: OutgoingEmail[]): Promise<SendResult>;
}
