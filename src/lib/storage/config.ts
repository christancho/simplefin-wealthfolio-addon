import type { HostAPI } from '@wealthfolio/addon-sdk';
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
}

const CONFIG_KEY = storageKey('config');

export function emptyConfig(): SyncConfig {
  return { baseUrl: null, mappings: [] };
}

export async function readConfig(api: HostAPI): Promise<SyncConfig> {
  const raw = await api.storage.get(CONFIG_KEY);
  if (!raw) return emptyConfig();

  try {
    return JSON.parse(raw) as SyncConfig;
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
