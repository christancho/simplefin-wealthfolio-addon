import { describe, expect, it } from 'vitest';
import { compareBalances } from './balance';

describe('compareBalances', () => {
  it('reports no mismatch for equal balances', () => {
    expect(compareBalances('100.00', '100.00')).toBeNull();
  });

  it('treats differing decimal representations of the same value as equal', () => {
    expect(compareBalances('100.0', '100.00')).toBeNull();
    expect(compareBalances('-0.00', '0.00')).toBeNull();
  });

  it('reports a mismatch with both figures', () => {
    expect(compareBalances('100.00', '90.00')).toEqual({
      simplefin: '100.00',
      wealthfolio: '90.00',
    });
  });

  it('returns null when the Wealthfolio balance is unavailable', () => {
    // Rule: if a value cannot be computed, return null rather than a magic number.
    expect(compareBalances('100.00', null)).toBeNull();
  });
});
