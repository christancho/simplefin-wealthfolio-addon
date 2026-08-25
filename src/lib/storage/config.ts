import type { AccountType, HostAPI } from '@wealthfolio/addon-sdk';
import { storageKey } from './keys';

/** How a mapped SimpleFIN account is pushed into Wealthfolio. */
export type SyncMode = 'CASH' | 'HOLDINGS';

export interface AccountMapping {
  sfAccountId: string;
  wfAccountId: string;
  mode: SyncMode;
  /** Cached for display when the Bridge is unreachable. */
  sfAccountName: string;
  orgName: string;
}

export interface SyncConfig {
  /** Credential-free SimpleFIN base URL. Credentials live in `secrets`. */
  baseUrl: string | null;
  mappings: AccountMapping[];
  /** Floor on how far back a sync ever asks the Bridge for, in days. */
  lookbackDays: number;
  /** Case-insensitive substrings checked against a card credit's payee/comment to detect a bill payment. */
  paymentKeywords: string[];
  /** Case-insensitive substrings checked against a cash-account deposit's payee/comment to detect an internal transfer. */
  transferKeywords: string[];
}

/** One statement cycle — enough to seed a new account without an unbounded first pull. */
export const DEFAULT_LOOKBACK_DAYS = 30;

/** Common bill-payment phrasing across US/Canadian card issuers. */
export const DEFAULT_PAYMENT_KEYWORDS = ['PAYMENT', 'AUTOPAY', 'THANK YOU'];

/** Common internal-transfer phrasing between a user's own cash accounts. */
export const DEFAULT_TRANSFER_KEYWORDS = ['TRANSFER', 'XFER'];

const CONFIG_KEY = storageKey('config');

export function emptyConfig(): SyncConfig {
  return {
    baseUrl: null,
    mappings: [],
    lookbackDays: DEFAULT_LOOKBACK_DAYS,
    paymentKeywords: DEFAULT_PAYMENT_KEYWORDS,
    transferKeywords: DEFAULT_TRANSFER_KEYWORDS,
  };
}

export async function readConfig(api: HostAPI): Promise<SyncConfig> {
  const raw = await api.storage.get(CONFIG_KEY);
  if (!raw) return emptyConfig();

  try {
    const parsed = JSON.parse(raw) as Partial<SyncConfig>;
    // `lookbackDays`/`paymentKeywords`/`transferKeywords` were each added
    // after configs already existed in the wild; default them for anything
    // written by an older version of the addon.
    return { ...emptyConfig(), ...parsed };
  } catch (error) {
    // Returning empty sends the user back to setup, which is recoverable;
    // throwing here would leave the addon permanently unopenable.
    api.logger.error(`[simplefin] corrupt config, falling back to empty: ${String(error)}`);
    return emptyConfig();
  }
}

export async function writeConfig(api: HostAPI, config: SyncConfig): Promise<void> {
  await api.storage.set(CONFIG_KEY, JSON.stringify(config));
}

/**
 * `mode` is the sync mode ('CASH' | 'HOLDINGS'), not the Wealthfolio account
 * type — `defaultModeFor` assigns 'CASH' to any account with no holdings,
 * which is exactly what a mapped credit-card account gets. Reconciliation's
 * withdrawal search must never include a card's own account (every purchase
 * on it is a WITHDRAWAL), so this also excludes CREDIT_CARD accounts. The
 * same pool doubles as the eligible-destination set for cash-to-cash
 * transfer detection — every account here is a non-card `CASH`-mode mapping.
 */
export function cashAccountIdsFrom(
  mappings: AccountMapping[],
  accountTypeOf: (wfAccountId: string) => AccountType | undefined,
): string[] {
  return mappings
    .filter((m) => m.mode === 'CASH' && accountTypeOf(m.wfAccountId) !== 'CREDIT_CARD')
    .map((m) => m.wfAccountId);
}
