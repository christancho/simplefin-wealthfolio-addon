import { describe, expect, it, vi } from 'vitest';
import type { ActivityImport } from '@wealthfolio/addon-sdk';
import { createMockHost } from '../../test/mockHost';
import type { SyncConfig } from '../storage/config';
import { writeWatermark } from '../storage/watermark';
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
  lookbackDays: 30,
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

  it('reaches back at least lookbackDays even when a sibling account already has a recent watermark', async () => {
    const host = okHost();
    const nowSeconds = Math.floor(Date.now() / 1000);
    const SECONDS_PER_DAY = 86_400;
    // ACT-1 already synced yesterday; ACT-2 was just mapped and has never synced.
    // Without a lookback floor, the shared fetch window would be dominated by
    // ACT-1's recent watermark and ACT-2 would never get its own history.
    await writeWatermark(host.api, 'ACT-1', {
      lastPosted: nowSeconds - SECONDS_PER_DAY,
      recentIds: [],
    });

    await runSync(host.api, { ...config, lookbackDays: 5 });

    const requestUrl = new URL(host.requests[0].url);
    const startDate = Number(requestUrl.searchParams.get('start-date'));
    const expectedFloor = nowSeconds - 5 * SECONDS_PER_DAY;
    expect(startDate).toBeLessThanOrEqual(expectedFloor);
  });

  it('reaches back further than lookbackDays when a watermark is older still', async () => {
    const host = okHost();
    const nowSeconds = Math.floor(Date.now() / 1000);
    const SECONDS_PER_DAY = 86_400;
    // An account stuck for 60 days should still get its overlap re-fetch even
    // though that's further back than the 5-day lookback floor.
    await writeWatermark(host.api, 'ACT-1', {
      lastPosted: nowSeconds - 60 * SECONDS_PER_DAY,
      recentIds: [],
    });

    await runSync(host.api, { ...config, lookbackDays: 5 });

    const requestUrl = new URL(host.requests[0].url);
    const startDate = Number(requestUrl.searchParams.get('start-date'));
    const lookbackFloor = nowSeconds - 5 * SECONDS_PER_DAY;
    expect(startDate).toBeLessThan(lookbackFloor);
  });
});

describe('runSync opening-balance backfill', () => {
  const backfillConfig: SyncConfig = {
    baseUrl: 'https://bridge.simplefin.org/simplefin',
    mappings: [
      {
        sfAccountId: 'ACT-1',
        wfAccountId: 'WF-1',
        mode: 'CASH',
        sfAccountName: 'Checking',
        orgName: 'Bank A',
      },
    ],
    lookbackDays: 30,
  };

  /** A Wealthfolio account whose balance actually moves as activities are pushed. */
  function backfillHost(sfBalance: string, transactions: unknown[]) {
    const host = createMockHost();
    host.respond(/\/accounts/, {
      body: JSON.stringify({
        errors: [],
        accounts: [
          {
            org: { name: 'Bank A' },
            id: 'ACT-1',
            name: 'Checking',
            currency: 'USD',
            balance: sfBalance,
            'balance-date': 1754524800,
            transactions,
            holdings: [],
          },
        ],
      }),
    });

    let wfBalance = 0;
    const pushed: ActivityImport[] = [];

    host.api.activities.checkImport = vi.fn(async (a: ActivityImport[]) =>
      a.map((row) => ({ ...row, isValid: true })),
    );
    host.api.activities.import = vi.fn(async (rows: ActivityImport[]) => {
      for (const row of rows) {
        pushed.push(row);
        const amount = Number(row.amount);
        wfBalance += row.activityType === 'WITHDRAWAL' || row.activityType === 'TRANSFER_OUT' ? -amount : amount;
      }
      return {
        activities: [],
        importRunId: 'R',
        summary: { total: rows.length, imported: rows.length, skipped: 0, duplicates: 0, assetsCreated: 0, success: true },
      };
    });
    host.api.accounts.getAll = vi.fn(async () => [{ id: 'WF-1', balance: wfBalance } as never]);

    return { host, pushed };
  }

  it('pushes a TRANSFER_IN opening-balance entry that closes the gap on first sync', async () => {
    const { host, pushed } = backfillHost('100.00', [
      { id: 'T1', posted: 1754438400, amount: '-10.00', description: 'X' },
    ]);

    const run = await runSync(host.api, backfillConfig);

    expect(pushed).toHaveLength(2);
    expect(pushed[0].activityType).toBe('WITHDRAWAL');
    expect(pushed[1].activityType).toBe('TRANSFER_IN');
    expect(pushed[1].amount).toBe('110.00');
    expect(run.accounts[0].imported).toBe(2);
  });

  it('fetches full unbounded history scoped to the account on first sync', async () => {
    const { host } = backfillHost('100.00', []);

    await runSync(host.api, backfillConfig);

    const backfillRequest = host.requests.find((r) => new URL(r.url).searchParams.get('start-date') === '0');
    expect(backfillRequest).toBeDefined();
    expect(new URL(backfillRequest!.url).searchParams.getAll('account')).toEqual(['ACT-1']);
  });

  it('skips the opening-balance entry when nothing needs to be plugged', async () => {
    const { host, pushed } = backfillHost('10.00', [
      { id: 'T1', posted: 1754438400, amount: '10.00', description: 'X' },
    ]);

    await runSync(host.api, backfillConfig);

    expect(pushed).toHaveLength(1);
    expect(pushed[0].activityType).toBe('DEPOSIT');
  });

  it('does not run the backfill fetch for a mapping that has already synced', async () => {
    const { host } = backfillHost('100.00', []);
    await writeWatermark(host.api, 'ACT-1', { lastPosted: 1754438400, recentIds: [] });

    await runSync(host.api, backfillConfig);

    expect(host.requests).toHaveLength(1);
  });

  it('does not run the backfill path for a HOLDINGS mapping', async () => {
    const { host } = backfillHost('100.00', []);

    await runSync(host.api, {
      ...backfillConfig,
      mappings: [{ ...backfillConfig.mappings[0], mode: 'HOLDINGS' }],
    });

    expect(host.requests).toHaveLength(1);
  });
});
