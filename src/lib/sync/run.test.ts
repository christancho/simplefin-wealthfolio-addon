import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ActivityImport } from '@wealthfolio/addon-sdk';
import { createMockHost } from '../../test/mockHost';
import type { SyncConfig } from '../storage/config';
import { readStaging, writeStaging } from '../storage/staging';
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
  paymentKeywords: ['PAYMENT', 'AUTOPAY', 'THANK YOU'],
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
  afterEach(() => {
    vi.useRealTimers();
  });

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

  it('detects a credit-card payment candidate during the account loop', async () => {
    const host = createMockHost();
    host.respond(/\/accounts/, {
      body: JSON.stringify({
        errors: [],
        accounts: [
          {
            org: { name: 'Card Co' },
            id: 'ACT-CARD',
            name: 'Visa',
            currency: 'USD',
            balance: '0.00',
            'balance-date': 1754524800,
            transactions: [
              { id: 'TXN-PAY', posted: 1754438400, amount: '50.00', description: 'Online Payment Thank You' },
            ],
            holdings: [],
          },
        ],
      }),
    });
    host.api.activities.checkImport = vi.fn(async (a: ActivityImport[]) => a.map((row) => ({ ...row, isValid: true })));
    host.api.activities.import = vi.fn(async () => ({
      activities: [],
      importRunId: 'R',
      summary: { total: 1, imported: 1, skipped: 0, duplicates: 0, assetsCreated: 0, success: true },
    }));
    host.api.activities.search = vi.fn(async () => ({ data: [], meta: { totalRowCount: 0 } }));
    host.api.accounts.getAll = vi.fn(async () => [{ id: 'ACT-CARD', accountType: 'CREDIT_CARD', balance: 0 }] as never);

    const cardConfig = {
      baseUrl: 'https://bridge.simplefin.org/simplefin',
      mappings: [
        {
          sfAccountId: 'ACT-CARD',
          wfAccountId: 'ACT-CARD',
          mode: 'CASH' as const,
          sfAccountName: 'Visa',
          orgName: 'Card Co',
        },
      ],
      lookbackDays: 30,
      paymentKeywords: ['PAYMENT'],
    };

    await runSync(host.api, cardConfig);

    // The reconciliation pass (wired in Task 6) will read this back; for now
    // just confirm detection ran without needing a search()/update() call —
    // 0 withdrawal candidates from the empty mock search means nothing to
    // reconcile against yet, and no error was thrown.
    expect(host.api.activities.import).toHaveBeenCalled();
  });

  it('persists a detected candidate and reconciles it against an existing withdrawal in the same run', async () => {
    // runSync's own nowSeconds is real wall-clock time, but the fixture below
    // reuses this file's fixed 2025-08-06 posted date; pin the clock nearby so
    // the 7-day expiry window in reconciliation.ts doesn't age it out
    // regardless of when this suite actually runs.
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1754438400 * 1000 + 2 * 86_400_000));

    const host = createMockHost();
    host.respond(/\/accounts/, {
      body: JSON.stringify({
        errors: [],
        accounts: [
          {
            org: { name: 'Card Co' },
            id: 'ACT-CARD',
            name: 'Visa',
            currency: 'USD',
            balance: '0.00',
            'balance-date': 1754438400,
            transactions: [
              { id: 'TXN-PAY', posted: 1754438400, amount: '50.00', description: 'Online Payment Thank You' },
            ],
            holdings: [],
          },
        ],
      }),
    });
    host.api.activities.checkImport = vi.fn(async (a: ActivityImport[]) => a.map((row) => ({ ...row, isValid: true })));
    host.api.activities.import = vi.fn(async () => ({
      activities: [],
      importRunId: 'R',
      summary: { total: 1, imported: 1, skipped: 0, duplicates: 0, assetsCreated: 0, success: true },
    }));
    host.api.activities.search = vi.fn(async (_p: number, _s: number, filters: { activityTypes: string }) => {
      if (filters.activityTypes === 'CREDIT') {
        return {
          data: [
            {
              id: 'CARD-ACT-1',
              accountId: 'ACT-CARD',
              activityType: 'CREDIT',
              date: '2025-08-06T00:00:00+00:00',
              amount: '50',
              currency: 'USD',
              comment: 'Online Payment Thank You',
            },
          ],
          meta: { totalRowCount: 1 },
        };
      }
      return {
        data: [
          {
            id: 'CASH-ACT-1',
            accountId: 'WF-CASH',
            activityType: 'WITHDRAWAL',
            date: '2025-08-05T00:00:00+00:00',
            amount: '50',
            currency: 'USD',
            comment: 'Bill Pay',
          },
        ],
        meta: { totalRowCount: 1 },
      };
    }) as never;
    host.api.activities.saveMany = vi.fn(async (req) => ({
      created: [],
      updated: req.updates ?? [],
      deleted: [],
      createdMappings: [],
      errors: [],
    })) as never;
    host.api.accounts.getAll = vi.fn(async () => [
      { id: 'ACT-CARD', accountType: 'CREDIT_CARD', balance: 0 },
      { id: 'WF-CASH', accountType: 'CASH', balance: 0 },
    ] as never);

    const cardConfig = {
      baseUrl: 'https://bridge.simplefin.org/simplefin',
      mappings: [
        { sfAccountId: 'ACT-CARD', wfAccountId: 'ACT-CARD', mode: 'CASH' as const, sfAccountName: 'Visa', orgName: 'Card Co' },
        { sfAccountId: 'WF-CASH', wfAccountId: 'WF-CASH', mode: 'CASH' as const, sfAccountName: 'Checking', orgName: 'Bank A' },
      ],
      lookbackDays: 30,
      paymentKeywords: ['PAYMENT'],
    };

    await runSync(host.api, cardConfig);

    expect(host.api.activities.saveMany).toHaveBeenCalledWith({
      updates: [
        expect.objectContaining({ id: 'CARD-ACT-1', activityType: 'TRANSFER_IN' }),
        expect.objectContaining({ id: 'CASH-ACT-1', activityType: 'TRANSFER_OUT' }),
      ],
    });
    expect(await readStaging(host.api)).toEqual([]);
  });

  it('keeps an unresolved candidate staged for the next run', async () => {
    const host = createMockHost();
    host.respond(/\/accounts/, { body: JSON.stringify({ errors: [], accounts: [] }) });
    host.api.accounts.getAll = vi.fn(async () => [{ id: 'ACT-CARD', accountType: 'CREDIT_CARD', balance: 0 }] as never);

    await writeStaging(host.api, [
      {
        sfTransactionId: 'TXN-OLD',
        cardAccountId: 'ACT-CARD',
        cardActivityId: null,
        amount: '50.00',
        postedDate: new Date().toISOString().slice(0, 10),
        comment: 'Online Payment Thank You',
        status: 'pending',
        candidateWithdrawalIds: [],
      },
    ]);
    host.api.activities.search = vi.fn(async () => ({ data: [], meta: { totalRowCount: 0 } })) as never;

    await runSync(host.api, {
      baseUrl: 'https://bridge.simplefin.org/simplefin',
      mappings: [],
      lookbackDays: 30,
      paymentKeywords: ['PAYMENT'],
    });

    const staged = await readStaging(host.api);
    expect(staged).toHaveLength(1);
    expect(staged[0].sfTransactionId).toBe('TXN-OLD');
  });

  it('does not let a reconciliation failure fail the whole sync run', async () => {
    const host = okHost();
    await writeStaging(host.api, [
      {
        sfTransactionId: 'TXN-BAD',
        cardAccountId: 'WF-1',
        cardActivityId: null,
        amount: '50.00',
        postedDate: new Date().toISOString().slice(0, 10),
        comment: 'Payment',
        status: 'pending',
        candidateWithdrawalIds: [],
      },
    ]);
    host.api.activities.search = vi.fn(async () => {
      throw new Error('search unavailable');
    }) as never;

    const run = await runSync(host.api, config);
    expect(run.accounts.every((a) => a.error === null)).toBe(true);
    expect(host.api.logger.error).toHaveBeenCalledWith(expect.stringContaining('search unavailable'));
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
    paymentKeywords: ['PAYMENT', 'AUTOPAY', 'THANK YOU'],
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
