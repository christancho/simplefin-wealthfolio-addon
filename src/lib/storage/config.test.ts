import { describe, expect, it } from 'vitest';
import { createMockHost } from '../../test/mockHost';
import { DEFAULT_LOOKBACK_DAYS, DEFAULT_PAYMENT_KEYWORDS, readConfig, writeConfig } from './config';

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
