// Types for scripts/account-delete.mjs, so packages/db's test can import it under tsc.
export interface PositionsKv {
  /** Every key under `prefix`, however many pages that takes. */
  listKeys(prefix: string): Promise<string[]>;
  deleteKeys(keys: string[]): Promise<void>;
}

export interface AccountDeleteOptions {
  connectionString: string;
  address: string;
  kv: PositionsKv;
  /** Puts the prompt to the operator and resolves with what they typed. */
  ask: (prompt: string) => Promise<string>;
  /** Waits for KV lists to catch up. Default: a minute and a second. */
  settle?: () => Promise<void>;
  log?: (line: string) => void;
}

export interface AccountDeleteResult {
  deleted: boolean;
  refused: string | null;
  error: string | null;
}

export function accountDelete(options: AccountDeleteOptions): Promise<AccountDeleteResult>;

/** How long the script waits for KV lists to catch up with a write. */
export const KV_LAG_MS: number;

/** The start of every key `apps/web`'s `positionKey` makes for this user. */
export function positionPrefix(userId: string): string;

export function positionsKv(options: {
  accountId: string;
  apiToken: string;
  namespaceId: string;
  fetch?: typeof fetch;
}): PositionsKv;
