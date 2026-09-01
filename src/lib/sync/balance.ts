/**
 * Compare two decimal strings without going through float. Balances are
 * compared by normalised value, so "100.0" and "100.00" agree. Reused by
 * `reconciliation.ts` for the same reason: Wealthfolio's persisted amount
 * strings don't preserve SimpleFIN's original decimal precision.
 */
export function normalise(value: string): string {
  const trimmed = value.trim();
  const negative = trimmed.startsWith('-');
  const [whole, fraction = ''] = trimmed.replace(/^[-+]/, '').split('.');
  const cleanWhole = whole.replace(/^0+(?=\d)/, '');
  const cleanFraction = fraction.replace(/0+$/, '');
  const magnitude = cleanFraction ? `${cleanWhole}.${cleanFraction}` : cleanWhole;

  // -0 and 0 are the same balance.
  if (/^0(\.0*)?$/.test(magnitude)) return '0';
  return negative ? `-${magnitude}` : magnitude;
}

export interface BalanceMismatch {
  simplefin: string;
  wealthfolio: string;
}

/**
 * Wealthfolio reports no balance for an account absent from
 * `getLatestValuations()`. Its own account-purpose policy excludes
 * `CREDIT_CARD` from that response (it supports neither the Performance nor
 * the Holdings purpose), so a card is always absent — the check is skipped,
 * never failed.
 */
export const NO_WEALTHFOLIO_BALANCE =
  'Wealthfolio reports no balance for this account (credit cards are excluded ' +
  'from its valuations)';

export interface BalanceCheck {
  mismatch: BalanceMismatch | null;
  /** Why the comparison couldn't be made, or null when it was made. */
  unchecked: string | null;
}

export function compareBalances(simplefin: string, wealthfolio: string | null): BalanceCheck {
  // No Wealthfolio figure means the check could not be computed. Reporting
  // that as "no mismatch" would be indistinguishable from a passing check.
  if (wealthfolio === null) {
    return { mismatch: null, unchecked: NO_WEALTHFOLIO_BALANCE };
  }

  return {
    mismatch: normalise(simplefin) === normalise(wealthfolio) ? null : { simplefin, wealthfolio },
    unchecked: null,
  };
}
