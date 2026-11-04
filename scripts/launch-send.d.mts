// Types for scripts/launch-send.mjs, so packages/db's test can import it under tsc.
export interface LaunchSendOptions {
  connectionString: string;
  accountId: string;
  queueId: string;
  apiToken: string;
  fetch?: typeof fetch;
  batchSize?: number;
  log?: (line: string) => void;
  signal?: AbortSignal;
}

export interface LaunchSendResult {
  queued: number;
  remaining: number | null;
  error: string | null;
}

export function launchSend(options: LaunchSendOptions): Promise<LaunchSendResult>;
