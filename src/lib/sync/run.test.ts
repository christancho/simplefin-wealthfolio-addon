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
  transferKeywords: ['TRANSFER', 'XFER'],
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
    // Not testing first-sync backfill here — mark both accounts already
    // synced so the opening-balance plug doesn't affect the imported counts.
    await writeWatermark(host.api, 'WF-1', { lastPosted: 1754438400 - 86_400, recentIds: [] });
    await writeWatermark(host.api, 'WF-2', { lastPosted: 1754438400 - 86_400, recentIds: [] });
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
    // WF-1 already synced yesterday; WF-2 was just mapped and has never synced.
    // Without a lookback floor, the shared fetch window would be dominated by
    // WF-1's recent watermark and WF-2 would never get its own history.
    await writeWatermark(host.api, 'WF-1', {
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
    await writeWatermark(host.api, 'WF-1', {
      lastPosted: nowSeconds - 60 * SECONDS_PER_DAY,
      recentIds: [],
    });

    await runSync(host.api, { ...config, lookbackDays: 5 });

    const requestUrl = new URL(host.requests[0].url);
    const startDate = Number(requestUrl.searchParams.get('start-date'));
    const lookbackFloor = nowSeconds - 5 * SECONDS_PER_DAY;
    expect(startDate).toBeLessThan(lookbackFloor);
  });

  it('never treats a mapped credit-card account as a cash account for withdrawal matching', async () => {
    // Regression for the final whole-branch review finding: `mode: 'CASH'`
    // is the sync mode, not the account type — `defaultModeFor` assigns it
    // to any account with no holdings, which is exactly what a mapped card
    // gets. If cashAccountIds ever includes the card's own account again,
    // its own same-amount purchase (also a WITHDRAWAL) becomes the sole
    // match and this candidate would wrongly auto-resolve instead of
    // staying pending.
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
    host.api.activities.search = vi.fn(async (_p: number, _s: number, filters: { accountIds: string[]; activityTypes: string }) => {
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
      // The only same-amount, in-window WITHDRAWAL lives on the card's own
      // account (its own purchase) — a real cash account never had one.
      if (filters.accountIds.includes('ACT-CARD')) {
        return {
          data: [
            {
              id: 'CARD-PURCHASE-1',
              accountId: 'ACT-CARD',
              activityType: 'WITHDRAWAL',
              date: '2025-08-05T00:00:00+00:00',
              amount: '50',
              currency: 'USD',
              comment: 'Groceries',
            },
          ],
          meta: { totalRowCount: 1 },
        };
      }
      return { data: [], meta: { totalRowCount: 0 } };
    }) as never;
    host.api.accounts.getAll = vi.fn(async () => [
      { id: 'ACT-CARD', accountType: 'CREDIT_CARD', balance: 0 },
      { id: 'WF-CASH', accountType: 'CASH', balance: 0 },
    ] as never);

    const cardConfig = {
      baseUrl: 'https://bridge.simplefin.org/simplefin',
      mappings: [
        { sfAccountId: 'ACT-CARD', wfAccountId: 'ACT-CARD', mode: 'CASH' as const, sfAccountName: 'Visa', orgName: 'Card Co' },
        { sfAccountId: 'ACT-CASH', wfAccountId: 'WF-CASH', mode: 'CASH' as const, sfAccountName: 'Checking', orgName: 'Bank A' },
      ],
      lookbackDays: 30,
      paymentKeywords: ['PAYMENT'],
      transferKeywords: ['TRANSFER', 'XFER'],
    };

    await runSync(host.api, cardConfig);

    expect(host.api.activities.saveMany).not.toHaveBeenCalled();
    const searchCalls = (host.api.activities.search as ReturnType<typeof vi.fn>).mock.calls as Array<
      [number, number, { activityTypes: string; accountIds: string[] }]
    >;
    const withdrawalCalls = searchCalls.filter(([, , filters]) => filters.activityTypes === 'WITHDRAWAL');
    expect(withdrawalCalls.every(([, , filters]) => !filters.accountIds.includes('ACT-CARD'))).toBe(true);

    const staged = await readStaging(host.api);
    expect(staged).toHaveLength(1);
    expect(staged[0].status).toBe('pending');
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
      transferKeywords: ['TRANSFER', 'XFER'],
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

  it('detects a cash-to-cash transfer candidate and reconciles it against an existing withdrawal in another cash account, in the same run', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1754438400 * 1000 + 2 * 86_400_000));

    const host = createMockHost();
    host.respond(/\/accounts/, {
      body: JSON.stringify({
        errors: [],
        accounts: [
          {
            org: { name: 'Bank B' },
            id: 'ACT-SAVINGS',
            name: 'Savings',
            currency: 'USD',
            balance: '0.00',
            'balance-date': 1754438400,
            transactions: [
              { id: 'TXN-XFER', posted: 1754438400, amount: '200.00', description: 'Online Transfer From Checking' },
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
      if (filters.activityTypes === 'DEPOSIT') {
        return {
          data: [
            {
              id: 'DEPOSIT-ACT-1',
              accountId: 'WF-SAVINGS',
              activityType: 'DEPOSIT',
              date: '2025-08-06T00:00:00+00:00',
              amount: '200',
              currency: 'USD',
              comment: 'Online Transfer From Checking',
            },
          ],
          meta: { totalRowCount: 1 },
        };
      }
      return {
        data: [
          {
            id: 'CHECKING-WD-1',
            accountId: 'WF-CHECKING',
            activityType: 'WITHDRAWAL',
            date: '2025-08-05T00:00:00+00:00',
            amount: '200',
            currency: 'USD',
            comment: 'Online Transfer To Savings',
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
      { id: 'WF-SAVINGS', accountType: 'CASH', balance: 0 },
      { id: 'WF-CHECKING', accountType: 'CASH', balance: 0 },
    ] as never);

    const transferConfig = {
      baseUrl: 'https://bridge.simplefin.org/simplefin',
      mappings: [
        { sfAccountId: 'ACT-SAVINGS', wfAccountId: 'WF-SAVINGS', mode: 'CASH' as const, sfAccountName: 'Savings', orgName: 'Bank B' },
        { sfAccountId: 'ACT-CHECKING', wfAccountId: 'WF-CHECKING', mode: 'CASH' as const, sfAccountName: 'Checking', orgName: 'Bank A' },
      ],
      lookbackDays: 30,
      paymentKeywords: ['PAYMENT'],
      transferKeywords: ['TRANSFER'],
    };

    await runSync(host.api, transferConfig);

    expect(host.api.activities.saveMany).toHaveBeenCalledWith({
      updates: [
        expect.objectContaining({ id: 'DEPOSIT-ACT-1', activityType: 'TRANSFER_IN' }),
        expect.objectContaining({ id: 'CHECKING-WD-1', activityType: 'TRANSFER_OUT' }),
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
        inflowAccountId: 'ACT-CARD',
        inflowActivityId: null,
        inflowActivityType: 'CREDIT',
        amount: '50.00',
        currency: 'USD',
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
      transferKeywords: ['TRANSFER', 'XFER'],
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
        inflowAccountId: 'WF-1',
        inflowActivityId: null,
        inflowActivityType: 'CREDIT',
        amount: '50.00',
        currency: 'USD',
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
    transferKeywords: ['TRANSFER', 'XFER'],
  };

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

    const pushed: ActivityImport[] = [];

    host.api.activities.checkImport = vi.fn(async (a: ActivityImport[]) =>
      a.map((row) => ({ ...row, isValid: true })),
    );
    host.api.activities.import = vi.fn(async (rows: ActivityImport[]) => {
      pushed.push(...rows);
      return {
        activities: [],
        importRunId: 'R',
        summary: { total: rows.length, imported: rows.length, skipped: 0, duplicates: 0, assetsCreated: 0, success: true },
      };
    });

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

  it('folds a pre-existing Wealthfolio balance into the plug instead of ignoring it', async () => {
    // A Wealthfolio account can have unrelated activity before it's ever
    // mapped to a SimpleFIN account — the plug must account for that
    // pre-existing balance, not assume the account started at zero. This
    // also guards against computing the plug from a live host read: a
    // `portfolio.recalculate()` + `getLatestValuations()` call right after
    // import is not guaranteed to reflect what was just pushed (confirmed
    // against a live host), so the plug must be derived only from values
    // already known to this run — the pre-sync snapshot and what it just
    // imported — never re-queried afterwards.
    const { host, pushed } = backfillHost('100.00', [
      { id: 'T1', posted: 1754438400, amount: '-10.00', description: 'X' },
    ]);
    host.api.portfolio.getLatestValuations = vi.fn(async () => [
      { accountId: 'WF-1', cashBalance: 500 } as never,
    ]);

    await runSync(host.api, backfillConfig);

    expect(pushed).toHaveLength(2);
    expect(pushed[1].activityType).toBe('TRANSFER_OUT');
    // sfBalance(100.00) - (preSync 500 + imported -10.00) = -390.00
    expect(pushed[1].amount).toBe('390.00');
  });

  it('fetches history capped at the Bridge-safe window, scoped to the account, on first sync', async () => {
    const { host } = backfillHost('100.00', []);
    const nowSeconds = Math.floor(Date.now() / 1000);
    const SECONDS_PER_DAY = 86_400;

    await runSync(host.api, backfillConfig);

    // The shared batch fetch (fired first) also scopes to this one mapping's
    // account, so take the *last* single-account request — the per-account
    // full-history pull that fires afterwards in syncOne.
    const singleAccountRequests = host.requests.filter(
      (r) => new URL(r.url).searchParams.getAll('account').length === 1,
    );
    const backfillRequest = singleAccountRequests[singleAccountRequests.length - 1];
    expect(singleAccountRequests.length).toBeGreaterThanOrEqual(2);
    expect(backfillRequest).toBeDefined();
    const startDate = Number(new URL(backfillRequest!.url).searchParams.get('start-date'));
    // 40 days back, give or take a second of test-run drift.
    expect(startDate).toBeGreaterThan(nowSeconds - 41 * SECONDS_PER_DAY);
    expect(startDate).toBeLessThanOrEqual(nowSeconds - 40 * SECONDS_PER_DAY);
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
    await writeWatermark(host.api, 'WF-1', { lastPosted: 1754438400, recentIds: [] });

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
