import { describe, expect, it } from 'vitest';
import { createMockHost } from '../../test/mockHost';
import { readConfig, writeConfig } from './config';

describe('config', () => {
  it('returns an empty config when nothing is stored', async () => {
    const host = createMockHost();
    expect(await readConfig(host.api)).toEqual({ baseUrl: null, mappings: [] });
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
    };
    await writeConfig(host.api, config);
    expect(await readConfig(host.api)).toEqual(config);
  });

  it('never stores credentials in the base URL', async () => {
    const host = createMockHost();
    await writeConfig(host.api, {
      baseUrl: 'https://bridge.simplefin.org/simplefin',
      mappings: [],
    });
    const stored = [...host.storage.values()].join('');
    expect(stored).not.toContain('@');
  });

  it('recovers from a corrupt config rather than throwing', async () => {
    const host = createMockHost();
    await host.api.storage.set('simplefin.config', '{not json');
    expect(await readConfig(host.api)).toEqual({ baseUrl: null, mappings: [] });
    expect(host.api.logger.error).toHaveBeenCalled();
  });
});
