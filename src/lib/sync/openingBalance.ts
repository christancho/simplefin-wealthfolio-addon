import type { AccountType, ActivityImport } from '@wealthfolio/addon-sdk';
import type { AccountMapping } from '../storage/config';

const SECONDS_PER_DAY = 86_400;

function parseParts(value: string): { negative: boolean; whole: string; frac: string } {
  const trimmed = value.trim();
  const negative = trimmed.startsWith('-');
  const unsigned = trimmed.replace(/^[-+]/, '');
  const [whole, frac = ''] = unsigned.split('.');
  return { negative, whole: whole || '0', frac };
}

/**
 * Subtracts two signed decimal strings via scaled BigInt arithmetic, never
 * going through float — money must not accumulate rounding error. Output is
 * padded to the wider of the two operands' decimal precision.
 */
export function subtractDecimal(a: string, b: string): string {
  const pa = parseParts(a);
  const pb = parseParts(b);
  const decimalPlaces = Math.max(pa.frac.length, pb.frac.length);

  const toScaledBigInt = (p: ReturnType<typeof parseParts>): bigint => {
    const paddedFrac = p.frac.padEnd(decimalPlaces, '0');
    const magnitude = BigInt(`${p.whole}${paddedFrac}` || '0');
    return p.negative ? -magnitude : magnitude;
  };

  const diff = toScaledBigInt(pa) - toScaledBigInt(pb);
  const sign = diff < 0n ? '-' : '';
  const absDigits = (diff < 0n ? -diff : diff).toString().padStart(decimalPlaces + 1, '0');

  if (decimalPlaces === 0) return `${sign}${absDigits}`;

  const whole = absDigits.slice(0, -decimalPlaces);
  const frac = absDigits.slice(-decimalPlaces);
  return `${sign}${whole}.${frac}`;
}

function negateDecimal(value: string): string {
  if (/^0(\.0*)?$/.test(value.trim())) return value;
  return value.trim().startsWith('-') ? value.trim().slice(1) : `-${value.trim()}`;
}

/** Sums signed decimal strings via `subtractDecimal`, so the same BigInt-safe arithmetic applies. */
export function sumDecimal(values: string[]): string {
  return values.reduce((acc, v) => subtractDecimal(acc, negateDecimal(v)), '0');
}

export interface OpeningBalanceInput {
  sfBalance: string;
  wfBalance: string;
  /** Epoch seconds of the earliest posted transaction pulled this run, or null if there were none. */
  earliestPosted: number | null;
  /** Epoch seconds; used as the entry date when there is no transaction to anchor to. */
  balanceDate: number;
}

function isoDate(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toISOString().slice(0, 10);
}

/**
 * One-time synthetic activity that plugs the gap between SimpleFIN's current
 * balance and whatever landed in Wealthfolio from the full-history backfill —
 * returns null when there is no gap.
 *
 * Never built for a credit-card account: a card's balance self-zeros every
 * statement cycle, so the plug would be a vendor-less charge with no lasting
 * meaning, sitting in the first cycle's history and skewing that month's
 * spend view. Real transactions are the only source of truth there.
 *
 * Imported as `DEPOSIT`/`WITHDRAWAL`, never `TRANSFER_IN`/`TRANSFER_OUT` —
 * this plug has no counterparty leg by construction (it's money the account
 * already had before this addon started tracking it, not a transfer between
 * two tracked accounts), so typing it as a transfer would leave it
 * permanently unlinkable and always flagged by Wealthfolio's Data
 * Consistency checker.
 */
export function buildOpeningBalanceActivity(
  input: OpeningBalanceInput,
  mapping: AccountMapping,
  currency: string,
  destinationAccountType: AccountType,
): ActivityImport | null {
  if (destinationAccountType === 'CREDIT_CARD') return null;

  const remainder = subtractDecimal(input.sfBalance, input.wfBalance);
  if (/^0(\.0*)?$/.test(remainder)) return null;

  const isOutflow = remainder.startsWith('-');
  const magnitude = remainder.replace(/^-/, '');
  const dateEpoch =
    input.earliestPosted !== null ? input.earliestPosted - SECONDS_PER_DAY : input.balanceDate;

  return {
    accountId: mapping.wfAccountId,
    activityType: isOutflow ? 'WITHDRAWAL' : 'DEPOSIT',
    date: isoDate(dateEpoch),
    amount: magnitude,
    currency,
    symbol: '',
    comment: 'Opening balance (SimpleFIN migration)',
    isValid: true,
    isDraft: false,
  };
}
