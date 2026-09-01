import type { HostAPI } from '@wealthfolio/addon-sdk';
import type { SfBridgeError } from '../simplefin/parse';
import { storageKey } from './keys';

export interface AccountRunResult {
  sfAccountId: string;
  sfAccountName: string;
  orgName: string;
  wfAccountId: string;
  mode: 'CASH' | 'HOLDINGS';
  /** null when the account failed before anything was counted. */
  imported: number | null;
  skipped: number | null;
  duplicates: number | null;
  /** Populated only when this account failed; other accounts are unaffected. */
  error: string | null;
  /** Set when SimpleFIN and Wealthfolio balances disagree after the run. */
  balanceMismatch: { simplefin: string; wealthfolio: string } | null;
  /**
   * Why the balance check couldn't run, or null when it did run and agreed.
   * A clean run and a skipped check both leave `balanceMismatch` null, and
   * reporting them the same way lets a credit card — which Wealthfolio never
   * returns a balance for — read as "verified" when nothing was verified.
   *
   * Optional because runs recorded before this field existed carry neither
   * value; `undefined` there means "unknown", not "checked".
   */
  balanceUnchecked?: string | null;
  /**
   * Non-fatal problem worth showing the user — the account still synced.
   * Distinct from `error`, which means the account produced nothing.
   */
  warning?: string | null;
}

export interface SyncRun {
  startedAt: string;
  finishedAt: string;
  accounts: AccountRunResult[];
  bridgeErrors: SfBridgeError[];
}

/**
 * Runs retained. The whole history is one storage value, and the host caps
 * values at ~250 KB; 20 runs across a realistic account count stays far below
 * that while covering enough history to spot a recurring failure.
 */
export const HISTORY_LIMIT = 20;

const HISTORY_KEY = storageKey('history');

export async function readHistory(api: HostAPI): Promise<SyncRun[]> {
  const raw = await api.storage.get(HISTORY_KEY);
  if (!raw) return [];

  try {
    return JSON.parse(raw) as SyncRun[];
  } catch (error) {
    api.logger.error(`[simplefin] corrupt history, starting fresh: ${String(error)}`);
    return [];
  }
}

export async function appendRun(api: HostAPI, run: SyncRun): Promise<void> {
  const history = await readHistory(api);
  const next = [run, ...history].slice(0, HISTORY_LIMIT);
  await api.storage.set(HISTORY_KEY, JSON.stringify(next));
}
