import { describe, expect, it } from 'vitest';
import { storageKey } from './keys';

describe('storageKey', () => {
  it('namespaces parts under the addon prefix', () => {
    expect(storageKey('wm', 'ACT-1')).toBe('simplefin.wm.ACT-1');
  });

  it('replaces characters outside the host-allowed charset', () => {
    // Host allows [A-Za-z0-9_.:-] only.
    expect(storageKey('wm', 'ACT/1 2')).toBe('simplefin.wm.ACT_1_2');
  });

  it('rejects a key that exceeds the host limit of 128 characters', () => {
    expect(() => storageKey('wm', 'x'.repeat(200))).toThrow(/128/);
  });
});
