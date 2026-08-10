import type { NetworkAPI } from '@wealthfolio/addon-sdk';
import { KEY_PREFIX } from '../constants';
import { parseAccountsResponse, type SfAccount, type SfBridgeError } from './parse';

/** Secret key holding base64(user:pass); resolved host-side by the network broker. */
export const AUTH_SECRET_KEY = `${KEY_PREFIX}.auth`;

export interface FetchAccountsOptions {
  /** Epoch seconds. */
  startDate?: number;
  /** Epoch seconds. */
  endDate?: number;
  pending?: boolean;
  accountIds?: string[];
  balancesOnly?: boolean;
}

export async function fetchAccounts(
  net: NetworkAPI,
  baseUrl: string,
  options: FetchAccountsOptions,
): Promise<{ accounts: SfAccount[]; errors: SfBridgeError[] }> {
  const url = new URL(`${baseUrl}/accounts`);

  if (options.startDate !== undefined) {
    url.searchParams.set('start-date', String(options.startDate));
  }
  if (options.endDate !== undefined) {
    url.searchParams.set('end-date', String(options.endDate));
  }
  if (options.pending) {
    url.searchParams.set('pending', '1');
  }
  if (options.balancesOnly) {
    url.searchParams.set('balances-only', '1');
  }
  for (const id of options.accountIds ?? []) {
    url.searchParams.append('account', id);
  }

  const response = await net.request({
    url: url.toString(),
    method: 'GET',
    auth: { type: 'basic', secretKey: AUTH_SECRET_KEY },
  });

  if (response.status !== 200) {
    throw new Error(`SimpleFIN Bridge returned HTTP ${response.status}`);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(response.body);
  } catch {
    // Bridges behind a proxy return HTML on outage; surface that plainly
    // rather than letting a SyntaxError bubble up unattributed.
    throw new Error('SimpleFIN Bridge returned a body that is not valid JSON');
  }

  // Bridge errors are returned, not thrown: a failing institution must not
  // prevent the healthy accounts in the same response from syncing.
  return parseAccountsResponse(payload);
}
