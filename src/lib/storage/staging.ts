import type { HostAPI } from '@wealthfolio/addon-sdk';
import { storageKey } from './keys';

export type CandidateStatus = 'pending' | 'ambiguous';

/** Which Wealthfolio activity type the staged inflow leg imported as. */
export type InflowActivityType = 'CREDIT' | 'DEPOSIT';

export interface StagedCandidate {
  /**
   * Identity: the SimpleFIN transaction id of the inflow leg (card CREDIT or
   * cash-transfer DEPOSIT) for a live-detected candidate — or, for a
   * `backfilled` one (where the original SimpleFIN id isn't recoverable), the
   * Wealthfolio activity id. Only ever used as an opaque key; never compared
   * against real SimpleFIN data.
   */
  sfTransactionId: string;
  /** Wealthfolio account id the inflow leg landed on. */
  inflowAccountId: string;
  /** Real Wealthfolio activity id — null until a reconciliation pass resolves it via search(). */
  inflowActivityId: string | null;
  /** 'CREDIT' for a credit-card bill payment; 'DEPOSIT' for a cash-to-cash transfer. */
  inflowActivityType: InflowActivityType;
  amount: string;
  currency: string;
  /** ISO date (YYYY-MM-DD) the inflow leg posted. */
  postedDate: string;
  comment: string;
  status: CandidateStatus;
  /** Populated once status is 'ambiguous'; the real Wealthfolio activity ids of the competing withdrawals. */
  candidateWithdrawalIds: string[];
  /**
   * Set for candidates found by scanning already-imported activities rather
   * than detected during a live sync. These predate the 7-day match window by
   * definition, so they're exempt from the expiry sweep in `runReconciliation`
   * — they stay staged until a user resolves or dismisses them.
   */
  backfilled?: boolean;
}

const STAGING_KEY = storageKey('staging');

export async function readStaging(api: HostAPI): Promise<StagedCandidate[]> {
  const raw = await api.storage.get(STAGING_KEY);
  if (!raw) return [];

  try {
    return JSON.parse(raw) as StagedCandidate[];
  } catch (error) {
    api.logger.error(`[simplefin] corrupt staging store, starting fresh: ${String(error)}`);
    return [];
  }
}

export async function writeStaging(api: HostAPI, candidates: StagedCandidate[]): Promise<void> {
  await api.storage.set(STAGING_KEY, JSON.stringify(candidates));
}
