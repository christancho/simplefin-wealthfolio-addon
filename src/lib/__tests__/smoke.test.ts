import { describe, expect, it } from 'vitest';
import { ADDON_ID } from '../constants';

describe('addon constants', () => {
  it('exposes the canonical addon id', () => {
    expect(ADDON_ID).toBe('simplefin-wealthfolio-addon');
  });
});
