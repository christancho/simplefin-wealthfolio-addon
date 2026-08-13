import { describe, expect, it } from 'vitest';
import type { AccountMapping } from '../storage/config';
import { buildOpeningBalanceActivity, subtractDecimal } from './openingBalance';

describe('subtractDecimal', () => {
  it('subtracts two decimal strings without float rounding', () => {
    expect(subtractDecimal('100.00', '80.00')).toBe('20.00');
  });

  it('produces a negative result when b exceeds a', () => {
    expect(subtractDecimal('50.00', '80.00')).toBe('-30.00');
  });

  it('produces a bare zero, never "-0", when the operands are equal', () => {
    expect(subtractDecimal('50.00', '50.00')).toBe('0.00');
  });

  it('scales operands with differing decimal precision to the wider one', () => {
    expect(subtractDecimal('100', '99.999')).toBe('0.001');
  });

  it('returns an integer string when neither operand has a fraction', () => {
    expect(subtractDecimal('100', '80')).toBe('20');
  });
});

describe('buildOpeningBalanceActivity', () => {
  const mapping: AccountMapping = {
    sfAccountId: 'ACT-1',
    wfAccountId: 'WF-1',
    mode: 'CASH',
    sfAccountName: 'Checking',
    orgName: 'Test Bank',
  };

  it('returns null when the SimpleFIN and Wealthfolio balances already agree', () => {
    const activity = buildOpeningBalanceActivity(
      { sfBalance: '100.00', wfBalance: '100.00', earliestPosted: 1754438400, balanceDate: 1754524800 },
      mapping,
      'USD',
    );
    expect(activity).toBeNull();
  });

  it('builds a TRANSFER_IN when Wealthfolio is short of the SimpleFIN balance', () => {
    const activity = buildOpeningBalanceActivity(
      { sfBalance: '100.00', wfBalance: '80.00', earliestPosted: 1754438400, balanceDate: 1754524800 },
      mapping,
      'USD',
    );
    expect(activity?.activityType).toBe('TRANSFER_IN');
    expect(activity?.amount).toBe('20.00');
    expect(activity?.accountId).toBe('WF-1');
    expect(activity?.currency).toBe('USD');
  });

  it('builds a TRANSFER_OUT when Wealthfolio holds more than the SimpleFIN balance', () => {
    const activity = buildOpeningBalanceActivity(
      { sfBalance: '50.00', wfBalance: '80.00', earliestPosted: 1754438400, balanceDate: 1754524800 },
      mapping,
      'USD',
    );
    expect(activity?.activityType).toBe('TRANSFER_OUT');
    expect(activity?.amount).toBe('30.00');
  });

  it('dates the entry one day before the earliest posted transaction', () => {
    const activity = buildOpeningBalanceActivity(
      { sfBalance: '100.00', wfBalance: '80.00', earliestPosted: 1754438400, balanceDate: 1754524800 },
      mapping,
      'USD',
    );
    // earliestPosted 1754438400 -> 2025-08-06; one day before -> 2025-08-05
    expect(activity?.date).toBe('2025-08-05');
  });

  it('falls back to the balance date when there is no transaction to anchor to', () => {
    const activity = buildOpeningBalanceActivity(
      { sfBalance: '100.00', wfBalance: '0', earliestPosted: null, balanceDate: 1754524800 },
      mapping,
      'USD',
    );
    expect(activity?.date).toBe('2025-08-07');
  });

  it('sets symbol to an empty string, matching the host requirement for cash activities', () => {
    const activity = buildOpeningBalanceActivity(
      { sfBalance: '100.00', wfBalance: '80.00', earliestPosted: 1754438400, balanceDate: 1754524800 },
      mapping,
      'USD',
    );
    expect(activity?.symbol).toBe('');
  });
});
