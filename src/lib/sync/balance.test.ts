import { describe, expect, it } from 'vitest';
import { compareBalances, NO_WEALTHFOLIO_BALANCE } from './balance';

describe('compareBalances', () => {
  it('reports a checked, matching balance', () => {
    expect(compareBalances('100.00', '100.00')).toEqual({ mismatch: null, unchecked: null });
  });

  it('treats differing decimal representations of the same value as equal', () => {
    expect(compareBalances('100.0', '100.00')).toEqual({ mismatch: null, unchecked: null });
    expect(compareBalances('-0.00', '0.00')).toEqual({ mismatch: null, unchecked: null });
  });

  it('reports a mismatch with both figures', () => {
    expect(compareBalances('100.00', '90.00')).toEqual({
      mismatch: { simplefin: '100.00', wealthfolio: '90.00' },
      unchecked: null,
    });
  });

  it('distinguishes an unavailable Wealthfolio balance from a passing check', () => {
    // A skipped check must never be reported the same way as a clean one —
    // Wealthfolio never returns a balance for a credit card, so reporting
    // "no mismatch" there would mark every card verified without verifying it.
    const result = compareBalances('100.00', null);
    expect(result.mismatch).toBeNull();
    expect(result.unchecked).toBe(NO_WEALTHFOLIO_BALANCE);
  });
});
