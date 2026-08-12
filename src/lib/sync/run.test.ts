import { describe, expect, it, vi } from 'vitest';
import type { ActivityImport } from '@wealthfolio/addon-sdk';
import { createMockHost } from '../../test/mockHost';
import type { SyncConfig } from '../storage/config';
import { runSync } from './run';

const config: SyncConfig = {
  baseUrl: 'https://bridge.simplefin.org/simplefin',
  mappings: [
    {
      sfAccountId: 'ACT-1',
      wfAccountId: 'WF-1',
      mode: 'CASH',
      sfAccountName: 'Checking',
      orgName: 'Bank A',
    },
    {
      sfAccountId: 'ACT-2',
      wfAccountId: 'WF-2',
      mode: 'CASH',
      sfAccountName: 'Savings',
      orgName: 'Bank B',
    },
  ],
};

const bridgePayload = {
  errors: [],
  accounts: [
    {
      org: { name: 'Bank A' },
      id: 'ACT-1',
      name: 'Checking',
      currency: 'USD',
      balance: '100.00',
      'balance-date': 1754524800,
      transactions: [{ id: 'T1', posted: 1754438400, amount: '-10.00', description: 'X' }],
      holdings: [],
    },
    {
      org: { name: 'Bank B' },
      id: 'ACT-2',
      name: 'Savings',
      currency: 'USD',
      balance: '200.00',
      'balance-date': 1754524800,
      transactions: [{ id: 'T2', posted: 1754438400, amount: '-20.00', description: 'Y' }],
      holdings: [],
    },
  ],
};

function okHost() {
  const host = createMockHost();
  host.respond(/\/accounts/, { body: JSON.stringify(bridgePayload) });
  host.api.activities.checkImport = vi.fn(async (a: ActivityImport[]) => a);
  host.api.activities.import = vi.fn(async () => ({
    activities: [],
    importRunId: 'R',
    summary: { total: 1, imported: 1, skipped: 0, duplicates: 0, assetsCreated: 0, success: true },
  }));
  host.api.accounts.getAll = vi.fn(async () => []);
  return host;
}

describe('runSync', () => {
  it('syncs every mapped account', async () => {
    const run = await runSync(okHost().api, config);
    expect(run.accounts).toHaveLength(2);
    expect(run.accounts.every((a) => a.error === null)).toBe(true);
  });

  it('isolates a per-account failure so the others still sync', async () => {
    const host = okHost();
    host.api.activities.import = vi.fn(async (rows: ActivityImport[]) => {
      if (rows[0].accountId === 'WF-1') throw new Error('WF-1 exploded');
      return {
        activities: [],
        importRunId: 'R',
        summary: {
          total: 1,
          imported: 1,
          skipped: 0,
          duplicates: 0,
          assetsCreated: 0,
          success: true,
        },
      };
    });

    const run = await runSync(host.api, config);

    const first = run.accounts.find((a) => a.wfAccountId === 'WF-1');
    const second = run.accounts.find((a) => a.wfAccountId === 'WF-2');
    expect(first?.error).toMatch(/exploded/);
    expect(second?.error).toBeNull();
    expect(second?.imported).toBe(1);
  });

  it('records bridge errors without aborting the run', async () => {
    const host = createMockHost();
    host.respond(/\/accounts/, {
      body: JSON.stringify({
        ...bridgePayload,
        errlist: [{ code: 'AUTH', msg: 'Reauthenticate Bank A', conn_id: 'C1' }],
      }),
    });
    host.api.activities.checkImport = vi.fn(async (a: ActivityImport[]) => a);
    host.api.activities.import = vi.fn(async () => ({
      activities: [],
      importRunId: 'R',
      summary: { total: 1, imported: 1, skipped: 0, duplicates: 0, assetsCreated: 0, success: true },
    }));
    host.api.accounts.getAll = vi.fn(async () => []);

    const run = await runSync(host.api, config);
    expect(run.bridgeErrors).toHaveLength(1);
    expect(run.accounts).toHaveLength(2);
  });

  it('records an account mapped to an id the Bridge did not return', async () => {
    const host = okHost();
    const run = await runSync(host.api, {
      ...config,
      mappings: [
        ...config.mappings,
        {
          sfAccountId: 'GONE',
          wfAccountId: 'WF-3',
          mode: 'CASH',
          sfAccountName: 'Old',
          orgName: 'Bank C',
        },
      ],
    });
    const missing = run.accounts.find((a) => a.wfAccountId === 'WF-3');
    expect(missing?.error).toMatch(/not returned by the Bridge/i);
  });

  it('persists the run to history', async () => {
    const host = okHost();
    await runSync(host.api, config);
    expect(host.storage.has('simplefin.history')).toBe(true);
  });

  it('throws when there is no configured base URL', async () => {
    const host = okHost();
    await expect(runSync(host.api, { ...config, baseUrl: null })).rejects.toThrow(/not connected/i);
  });
});
