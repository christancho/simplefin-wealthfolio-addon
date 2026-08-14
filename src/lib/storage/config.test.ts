import { describe, expect, it } from 'vitest';
import { createMockHost } from '../../test/mockHost';
import {
  DEFAULT_LOOKBACK_DAYS,
  DEFAULT_PAYMENT_KEYWORDS,
  cashAccountIdsFrom,
  readConfig,
  writeConfig,
  type AccountMapping,
} from './config';

describe('config', () => {
  it('returns an empty config when nothing is stored', async () => {
    const host = createMockHost();
    expect(await readConfig(host.api)).toEqual({
      baseUrl: null,
      mappings: [],
      lookbackDays: DEFAULT_LOOKBACK_DAYS,
      paymentKeywords: DEFAULT_PAYMENT_KEYWORDS,
    });
  });

  it('round-trips a config', async () => {
    const host = createMockHost();
    const config = {
      baseUrl: 'https://bridge.simplefin.org/simplefin',
      mappings: [
        {
          sfAccountId: 'ACT-1',
          wfAccountId: 'WF-1',
          mode: 'CASH' as const,
          sfAccountName: 'Checking',
          orgName: 'Test Bank',
        },
      ],
      lookbackDays: 60,
      paymentKeywords: ['PAYMENT', 'AUTOPAY'],
    };
    await writeConfig(host.api, config);
    expect(await readConfig(host.api)).toEqual(config);
  });

  it('defaults lookbackDays and paymentKeywords for a config written before those fields existed', async () => {
    const host = createMockHost();
    await host.api.storage.set(
      'simplefin.config',
      JSON.stringify({ baseUrl: 'https://bridge.simplefin.org/simplefin', mappings: [] }),
    );
    expect(await readConfig(host.api)).toEqual({
      baseUrl: 'https://bridge.simplefin.org/simplefin',
      mappings: [],
      lookbackDays: DEFAULT_LOOKBACK_DAYS,
      paymentKeywords: DEFAULT_PAYMENT_KEYWORDS,
    });
  });

  it('never stores credentials in the base URL', async () => {
    const host = createMockHost();
    await writeConfig(host.api, {
      baseUrl: 'https://bridge.simplefin.org/simplefin',
      mappings: [],
      lookbackDays: DEFAULT_LOOKBACK_DAYS,
      paymentKeywords: DEFAULT_PAYMENT_KEYWORDS,
    });
    const stored = [...host.storage.values()].join('');
    expect(stored).not.toContain('@');
  });

  it('recovers from a corrupt config rather than throwing', async () => {
    const host = createMockHost();
    await host.api.storage.set('simplefin.config', '{not json');
    expect(await readConfig(host.api)).toEqual({
      baseUrl: null,
      mappings: [],
      lookbackDays: DEFAULT_LOOKBACK_DAYS,
      paymentKeywords: DEFAULT_PAYMENT_KEYWORDS,
    });
    expect(host.api.logger.error).toHaveBeenCalled();
  });
});

describe('cashAccountIdsFrom', () => {
  const mapping = (over: Partial<AccountMapping> = {}): AccountMapping => ({
    sfAccountId: 'ACT-1',
    wfAccountId: 'WF-1',
    mode: 'CASH',
    sfAccountName: 'Account',
    orgName: 'Bank',
    ...over,
  });

  it('excludes a CREDIT_CARD account even when its mode is CASH', () => {
    const mappings = [
      mapping({ wfAccountId: 'WF-CARD' }),
      mapping({ wfAccountId: 'WF-CASH' }),
    ];
    const accountTypeOf = (id: string) => (id === 'WF-CARD' ? ('CREDIT_CARD' as const) : ('CASH' as const));

    expect(cashAccountIdsFrom(mappings, accountTypeOf)).toEqual(['WF-CASH']);
  });

  it('excludes a HOLDINGS-mode mapping regardless of account type', () => {
    const mappings = [mapping({ wfAccountId: 'WF-BROKERAGE', mode: 'HOLDINGS' })];

    expect(cashAccountIdsFrom(mappings, () => 'CASH' as const)).toEqual([]);
  });
});
