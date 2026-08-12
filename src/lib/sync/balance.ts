/**
 * Compare two decimal strings without going through float. Balances are
 * compared by normalised value, so "100.0" and "100.00" agree.
 */
function normalise(value: string): string {
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

export function compareBalances(
  simplefin: string,
  wealthfolio: string | null,
): BalanceMismatch | null {
  // No Wealthfolio figure means the check could not be computed — report
  // nothing rather than inventing a comparison.
  if (wealthfolio === null) return null;

  return normalise(simplefin) === normalise(wealthfolio)
    ? null
    : { simplefin, wealthfolio };
}
