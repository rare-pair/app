// Types for scripts/waitlist-purge.mjs, so packages/db's test can import it under tsc.
export interface WaitlistPurgeOptions {
  connectionString: string;
  force?: boolean;
  lockTimeoutMs?: number;
  log?: (line: string) => void;
}

export interface WaitlistPurgeResult {
  deleted: number;
  refused: string | null;
  error: string | null;
}

export function waitlistPurge(options: WaitlistPurgeOptions): Promise<WaitlistPurgeResult>;
