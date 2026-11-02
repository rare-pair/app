// Types for scripts/backfill.mjs, so packages/db's test can import it under tsc.
export interface BackfillOptions {
  connectionString: string;
  accountId: string;
  queueId: string;
  apiToken: string;
  after?: string | null;
  fetch?: typeof fetch;
  batchSize?: number;
  log?: (line: string) => void;
  signal?: AbortSignal;
}

export interface BackfillResult {
  queued: number;
  after: string | null;
  done: boolean;
  error: string | null;
}

export function backfill(options: BackfillOptions): Promise<BackfillResult>;
