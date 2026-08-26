import { describe, expect, it, vi } from 'vitest';
import type { ActivityDetails } from '@wealthfolio/addon-sdk';
import { createMockHost } from '../../test/mockHost';
import type { StagedCandidate } from '../storage/staging';
import {
  describeWithdrawals,
  findBackfillCandidates,
  findInflowActivity,
  resolveAmbiguous,
  runReconciliation,
} from './reconciliation';

const NOW = 1754438400 + 5 * 86_400; // 5 days after the fixtures' posted date

const candidate = (over: Partial<StagedCandidate> = {}): StagedCandidate => ({
  sfTransactionId: 'TXN-1',
  inflowAccountId: 'WF-CARD',
  inflowActivityId: null,
  inflowActivityType: 'CREDIT',
  amount: '50.00',
  currency: 'USD',
  postedDate: '2025-08-06',
  comment: 'Online Payment Thank You',
  status: 'pending',
  candidateWithdrawalIds: [],
  ...over,
});

const cardActivity = (over: Partial<ActivityDetails> = {}): ActivityDetails =>
  ({
    id: 'CARD-ACT-1',
    accountId: 'WF-CARD',
    activityType: 'CREDIT',
    date: '2025-08-06T00:00:00+00:00',
    amount: '50',
    currency: 'USD',
    comment: 'Online Payment Thank You',
    fee: null,
    subtype: null,
    ...over,
  }) as ActivityDetails;

const withdrawalActivity = (over: Partial<ActivityDetails> = {}): ActivityDetails =>
  ({
    id: 'CASH-ACT-1',
    accountId: 'WF-CASH',
    activityType: 'WITHDRAWAL',
    date: '2025-08-05T00:00:00+00:00',
    amount: '50',
    currency: 'USD',
    comment: 'Bill Pay',
    fee: null,
    subtype: null,
    ...over,
  }) as ActivityDetails;

describe('runReconciliation', () => {
  it('resolves a unique match by reclassifying both legs', async () => {
    const host = createMockHost();
    host.api.activities.search = vi.fn(async (page: number, _size: number, filters: { activityTypes: string }) => {
      if (page > 0) return { data: [], meta: { totalRowCount: 0 } };
      if (filters.activityTypes === 'CREDIT') return { data: [cardActivity()], meta: { totalRowCount: 1 } };
      return { data: [withdrawalActivity()], meta: { totalRowCount: 1 } };
    }) as never;

    const { candidates, summary } = await runReconciliation(host.api, [candidate()], ['WF-CASH'], NOW);

    expect(candidates).toHaveLength(0);
    expect(summary.resolved).toBe(1);
    expect(host.api.activities.saveMany).toHaveBeenCalledWith({
      creates: [
        {
          accountId: 'WF-CARD',
          activityType: 'TRANSFER_IN',
          activityDate: '2025-08-06T00:00:00+00:00',
          amount: '50',
          currency: 'USD',
          comment: 'Online Payment Thank You',
          fee: null,
          subtype: null,
          sourceGroupId: 'TXN-1',
        },
        {
          accountId: 'WF-CASH',
          activityType: 'TRANSFER_OUT',
          activityDate: '2025-08-05T00:00:00+00:00',
          amount: '50',
          currency: 'USD',
          comment: 'Bill Pay',
          fee: null,
          subtype: null,
          sourceGroupId: 'TXN-1',
        },
      ],
      deleteIds: ['CARD-ACT-1', 'CASH-ACT-1'],
    });
  });

  it('resolves a cash-to-cash transfer candidate (DEPOSIT inflow) the same way', async () => {
    const host = createMockHost();
    const depositActivity = cardActivity({
      id: 'DEPOSIT-ACT-1',
      accountId: 'WF-CASH-B',
      activityType: 'DEPOSIT',
      comment: 'Online Transfer From Checking',
    });
    const sourceWithdrawal = withdrawalActivity({ accountId: 'WF-CASH-A', comment: 'Online Transfer To Savings' });

    host.api.activities.search = vi.fn(async (_p: number, _s: number, filters: { activityTypes: string }) => {
      if (filters.activityTypes === 'DEPOSIT') return { data: [depositActivity], meta: { totalRowCount: 1 } };
      return { data: [sourceWithdrawal], meta: { totalRowCount: 1 } };
    }) as never;

    const transferCandidate = candidate({
      inflowAccountId: 'WF-CASH-B',
      inflowActivityType: 'DEPOSIT',
      comment: 'Online Transfer From Checking',
    });

    const { candidates, summary } = await runReconciliation(
      host.api,
      [transferCandidate],
      ['WF-CASH-A', 'WF-CASH-B'],
      NOW,
    );

    expect(candidates).toHaveLength(0);
    expect(summary.resolved).toBe(1);
    expect(host.api.activities.saveMany).toHaveBeenCalledWith({
      creates: [
        expect.objectContaining({ accountId: 'WF-CASH-B', activityType: 'TRANSFER_IN', sourceGroupId: 'TXN-1' }),
        expect.objectContaining({ accountId: 'WF-CASH-A', activityType: 'TRANSFER_OUT', sourceGroupId: 'TXN-1' }),
      ],
      deleteIds: ['DEPOSIT-ACT-1', 'CASH-ACT-1'],
    });
  });

  it("excludes a same-amount, in-window withdrawal sitting in the candidate's own inflow account", async () => {
    const host = createMockHost();
    const depositActivity = cardActivity({
      id: 'DEPOSIT-ACT-1',
      accountId: 'WF-CASH-B',
      activityType: 'DEPOSIT',
    });
    // This withdrawal is in the SAME account the transfer landed in (WF-CASH-B) —
    // it must never be treated as this candidate's own source leg.
    const selfAccountWithdrawal = withdrawalActivity({ id: 'SELF-WD', accountId: 'WF-CASH-B' });

    host.api.activities.search = vi.fn(async (_p: number, _s: number, filters: { activityTypes: string }) => {
      if (filters.activityTypes === 'DEPOSIT') return { data: [depositActivity], meta: { totalRowCount: 1 } };
      return { data: [selfAccountWithdrawal], meta: { totalRowCount: 1 } };
    }) as never;

    const transferCandidate = candidate({ inflowAccountId: 'WF-CASH-B', inflowActivityType: 'DEPOSIT' });

    const { candidates } = await runReconciliation(host.api, [transferCandidate], ['WF-CASH-B'], NOW);

    expect(candidates[0].status).toBe('pending');
    expect(host.api.activities.saveMany).not.toHaveBeenCalled();
  });

  it('stays pending with zero withdrawal matches', async () => {
    const host = createMockHost();
    host.api.activities.search = vi.fn(async (_p: number, _s: number, filters: { activityTypes: string }) => {
      if (filters.activityTypes === 'CREDIT') return { data: [cardActivity()], meta: { totalRowCount: 1 } };
      return { data: [], meta: { totalRowCount: 0 } };
    }) as never;

    const { candidates, summary } = await runReconciliation(host.api, [candidate()], ['WF-CASH'], NOW);

    expect(candidates).toHaveLength(1);
    expect(candidates[0].status).toBe('pending');
    expect(candidates[0].inflowActivityId).toBe('CARD-ACT-1');
    expect(summary.resolved).toBe(0);
    expect(host.api.activities.saveMany).not.toHaveBeenCalled();
  });

  it('marks ambiguous with two or more withdrawal matches, never auto-picking one', async () => {
    const host = createMockHost();
    host.api.activities.search = vi.fn(async (_p: number, _s: number, filters: { activityTypes: string }) => {
      if (filters.activityTypes === 'CREDIT') return { data: [cardActivity()], meta: { totalRowCount: 1 } };
      return {
        data: [withdrawalActivity(), withdrawalActivity({ id: 'CASH-ACT-2', accountId: 'WF-CASH-2' })],
        meta: { totalRowCount: 2 },
      };
    }) as never;

    const { candidates } = await runReconciliation(host.api, [candidate()], ['WF-CASH', 'WF-CASH-2'], NOW);

    expect(candidates[0].status).toBe('ambiguous');
    expect(candidates[0].candidateWithdrawalIds.sort()).toEqual(['CASH-ACT-1', 'CASH-ACT-2']);
    expect(host.api.activities.saveMany).not.toHaveBeenCalled();
  });

  it('marks ambiguous with two or more withdrawal matches for a cash-transfer (DEPOSIT) candidate too', async () => {
    const host = createMockHost();
    const depositActivity = cardActivity({
      id: 'DEPOSIT-ACT-1',
      accountId: 'WF-CASH-B',
      activityType: 'DEPOSIT',
    });

    host.api.activities.search = vi.fn(async (_p: number, _s: number, filters: { activityTypes: string }) => {
      if (filters.activityTypes === 'DEPOSIT') return { data: [depositActivity], meta: { totalRowCount: 1 } };
      return {
        data: [withdrawalActivity(), withdrawalActivity({ id: 'CASH-ACT-2', accountId: 'WF-CASH-2' })],
        meta: { totalRowCount: 2 },
      };
    }) as never;

    const transferCandidate = candidate({ inflowAccountId: 'WF-CASH-B', inflowActivityType: 'DEPOSIT' });

    const { candidates } = await runReconciliation(
      host.api,
      [transferCandidate],
      ['WF-CASH', 'WF-CASH-2', 'WF-CASH-B'],
      NOW,
    );

    expect(candidates[0].status).toBe('ambiguous');
    expect(candidates[0].candidateWithdrawalIds.sort()).toEqual(['CASH-ACT-1', 'CASH-ACT-2']);
    expect(host.api.activities.saveMany).not.toHaveBeenCalled();
  });

  it('excludes a withdrawal outside the 3-day match window', async () => {
    const host = createMockHost();
    host.api.activities.search = vi.fn(async (_p: number, _s: number, filters: { activityTypes: string }) => {
      if (filters.activityTypes === 'CREDIT') return { data: [cardActivity()], meta: { totalRowCount: 1 } };
      return {
        // `date` is typed as `Date`, but the live host actually serialises it as an ISO string —
        // this cast preserves that real runtime shape while satisfying the SDK's fixture typing.
        data: [withdrawalActivity({ date: '2025-07-30T00:00:00+00:00' as unknown as Date })], // 7 days before the card credit
        meta: { totalRowCount: 1 },
      };
    }) as never;

    const { candidates } = await runReconciliation(host.api, [candidate()], ['WF-CASH'], NOW);
    expect(candidates[0].status).toBe('pending');
  });

  it('matches amounts by normalised value, not raw string equality', async () => {
    const host = createMockHost();
    host.api.activities.search = vi.fn(async (_p: number, _s: number, filters: { activityTypes: string }) => {
      if (filters.activityTypes === 'CREDIT') return { data: [cardActivity()], meta: { totalRowCount: 1 } };
      // Wealthfolio's persisted form ("50") differs from the candidate's stored form ("50.00").
      return { data: [withdrawalActivity({ amount: '50' })], meta: { totalRowCount: 1 } };
    }) as never;

    const { summary } = await runReconciliation(host.api, [candidate({ amount: '50.00' })], ['WF-CASH'], NOW);
    expect(summary.resolved).toBe(1);
  });

  it('drops a candidate older than the 7-day expiry without creating a transfer', async () => {
    const host = createMockHost();
    host.api.activities.search = vi.fn();

    const old = candidate({ postedDate: '2025-07-01' });
    const { candidates, summary } = await runReconciliation(host.api, [old], ['WF-CASH'], NOW);

    expect(candidates).toHaveLength(0);
    expect(summary.expired).toBe(1);
    expect(host.api.activities.search).not.toHaveBeenCalled();
  });

  it('drops a legacy staging record missing inflowAccountId/inflowActivityType without searching', async () => {
    const host = createMockHost();
    host.api.activities.search = vi.fn();

    // Simulates a record persisted before the cardAccountId/cardActivityId ->
    // inflowAccountId/inflowActivityId rename and the inflowActivityType
    // addition: those fields are absent under the old shape, so they read as
    // undefined here despite the StagedCandidate type requiring them.
    const legacy = candidate({ inflowAccountId: undefined, inflowActivityType: undefined } as never);

    const { candidates, summary } = await runReconciliation(host.api, [legacy], ['WF-CASH'], NOW);

    expect(candidates).toHaveLength(0);
    expect(summary.expired).toBe(1);
    expect(host.api.activities.search).not.toHaveBeenCalled();
  });

  it('never expires a backfilled candidate, however old its posted date', async () => {
    const host = createMockHost();
    host.api.activities.search = vi.fn(async (_p: number, _s: number, filters: { activityTypes: string }) => {
      if (filters.activityTypes === 'CREDIT') return { data: [cardActivity()], meta: { totalRowCount: 1 } };
      return { data: [], meta: { totalRowCount: 0 } };
    }) as never;

    const old = candidate({ postedDate: '2025-07-01', backfilled: true });
    const { candidates, summary } = await runReconciliation(host.api, [old], ['WF-CASH'], NOW);

    expect(summary.expired).toBe(0);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].status).toBe('pending');
  });

  it('isolates a per-candidate failure so other candidates still resolve', async () => {
    const host = createMockHost();
    host.api.activities.search = vi.fn(async (_p: number, _s: number, filters: { accountIds: string[]; activityTypes: string }) => {
      if (filters.accountIds[0] === 'WF-CARD-BAD') throw new Error('search exploded');
      if (filters.activityTypes === 'CREDIT') return { data: [cardActivity()], meta: { totalRowCount: 1 } };
      return { data: [withdrawalActivity()], meta: { totalRowCount: 1 } };
    }) as never;

    const bad = candidate({ sfTransactionId: 'TXN-BAD', inflowAccountId: 'WF-CARD-BAD' });
    const good = candidate({ sfTransactionId: 'TXN-GOOD' });

    const { candidates, summary } = await runReconciliation(host.api, [bad, good], ['WF-CASH'], NOW);

    expect(summary.resolved).toBe(1);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].sfTransactionId).toBe('TXN-BAD');
    expect(host.api.logger.error).toHaveBeenCalledWith(expect.stringContaining('TXN-BAD'));
  });

  it('re-stages the candidate when saveMany resolves with per-item errors instead of throwing', async () => {
    const host = createMockHost();
    host.api.activities.search = vi.fn(async (_p: number, _s: number, filters: { activityTypes: string }) => {
      if (filters.activityTypes === 'CREDIT') return { data: [cardActivity()], meta: { totalRowCount: 1 } };
      return { data: [withdrawalActivity()], meta: { totalRowCount: 1 } };
    }) as never;
    host.api.activities.saveMany = vi.fn(async () => ({
      created: [],
      updated: [],
      deleted: [],
      createdMappings: [],
      errors: [{ id: 'CARD-ACT-1', action: 'create', message: 'row locked' }],
    })) as never;

    const { candidates, summary } = await runReconciliation(host.api, [candidate()], ['WF-CASH'], NOW);

    expect(summary.resolved).toBe(0);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].sfTransactionId).toBe('TXN-1');
    expect(host.api.logger.error).toHaveBeenCalledWith(expect.stringContaining('TXN-1'));
  });

  it('fetches the withdrawal search once per run rather than once per candidate', async () => {
    const host = createMockHost();
    let withdrawalSearchCalls = 0;
    host.api.activities.search = vi.fn(async (_p: number, _s: number, filters: { activityTypes: string }) => {
      if (filters.activityTypes === 'CREDIT') return { data: [cardActivity()], meta: { totalRowCount: 1 } };
      withdrawalSearchCalls += 1;
      return { data: [], meta: { totalRowCount: 0 } };
    }) as never;

    const candidates = [
      candidate({ sfTransactionId: 'TXN-1' }),
      candidate({ sfTransactionId: 'TXN-2' }),
      candidate({ sfTransactionId: 'TXN-3' }),
    ];
    await runReconciliation(host.api, candidates, ['WF-CASH'], NOW);

    expect(withdrawalSearchCalls).toBe(1);
  });

  it('does not let a second same-amount candidate double-claim a withdrawal already claimed this run', async () => {
    const host = createMockHost();
    host.api.activities.search = vi.fn(async (_p: number, _s: number, filters: { activityTypes: string }) => {
      if (filters.activityTypes === 'CREDIT') {
        return { data: [cardActivity(), cardActivity({ id: 'CARD-ACT-2' })], meta: { totalRowCount: 2 } };
      }
      // Only one real withdrawal exists to match against both candidates.
      return { data: [withdrawalActivity()], meta: { totalRowCount: 1 } };
    }) as never;

    const first = candidate({ sfTransactionId: 'TXN-1', inflowActivityId: 'CARD-ACT-1' });
    const second = candidate({ sfTransactionId: 'TXN-2', inflowActivityId: 'CARD-ACT-2' });

    const { candidates, summary } = await runReconciliation(host.api, [first, second], ['WF-CASH'], NOW);

    expect(summary.resolved).toBe(1);
    expect(host.api.activities.saveMany).toHaveBeenCalledTimes(1);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].sfTransactionId).toBe('TXN-2');
    expect(candidates[0].status).toBe('pending');
  });

  it('skips the withdrawal search and leaves candidates pending when cashAccountIds is empty', async () => {
    const host = createMockHost();
    host.api.activities.search = vi.fn(async (_p: number, _s: number, filters: { activityTypes: string }) => {
      if (filters.activityTypes === 'CREDIT') return { data: [cardActivity()], meta: { totalRowCount: 1 } };
      throw new Error('should never search for WITHDRAWAL when cashAccountIds is empty');
    }) as never;

    const { candidates, summary } = await runReconciliation(host.api, [candidate()], [], NOW);

    expect(host.api.activities.search).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ activityTypes: 'WITHDRAWAL' }),
      expect.anything(),
    );
    expect(candidates).toHaveLength(1);
    expect(candidates[0].status).toBe('pending');
    expect(summary.resolved).toBe(0);
  });

  it('paginates search() from page 0 until totalRowCount is covered', async () => {
    const host = createMockHost();
    const manyWithdrawals = Array.from({ length: 3 }, (_, i) => withdrawalActivity({ id: `PAGE-${i}` }));
    host.api.activities.search = vi.fn(async (page: number, pageSize: number, filters: { activityTypes: string }) => {
      if (filters.activityTypes === 'CREDIT') return { data: [cardActivity()], meta: { totalRowCount: 1 } };
      const slice = manyWithdrawals.slice(page * pageSize, page * pageSize + pageSize);
      return { data: slice, meta: { totalRowCount: manyWithdrawals.length } };
    }) as never;

    // pageSize is internal (200), so force multiple pages by shrinking the fixture set relative
    // to a a tiny stand-in: this test only needs to prove page starts at 0 and the loop terminates.
    await runReconciliation(host.api, [candidate()], ['WF-CASH'], NOW);
    expect(host.api.activities.search).toHaveBeenCalledWith(0, expect.any(Number), expect.anything(), '');
  });
});

describe('findInflowActivity', () => {
  it('resolves by accountId/amount/date/comment when inflowActivityId is unknown', async () => {
    const host = createMockHost();
    host.api.activities.search = vi.fn(async () => ({ data: [cardActivity()], meta: { totalRowCount: 1 } })) as never;

    const found = await findInflowActivity(host.api, candidate());
    expect(found?.id).toBe('CARD-ACT-1');
  });

  it('resolves by id directly once inflowActivityId is known', async () => {
    const host = createMockHost();
    host.api.activities.search = vi.fn(async () => ({
      data: [cardActivity(), cardActivity({ id: 'OTHER', comment: 'different' })],
      meta: { totalRowCount: 2 },
    })) as never;

    const found = await findInflowActivity(host.api, candidate({ inflowActivityId: 'OTHER' }));
    expect(found?.id).toBe('OTHER');
  });

  it("searches by the candidate's own inflowActivityType, not a hardcoded CREDIT", async () => {
    const host = createMockHost();
    let requestedType: string | undefined;
    host.api.activities.search = vi.fn(async (_p: number, _s: number, filters: { activityTypes: string }) => {
      requestedType = filters.activityTypes;
      return { data: [], meta: { totalRowCount: 0 } };
    }) as never;

    await findInflowActivity(host.api, candidate({ inflowActivityType: 'DEPOSIT' }));
    expect(requestedType).toBe('DEPOSIT');
  });
});

describe('describeWithdrawals', () => {
  it('returns full details for the requested ids only', async () => {
    const host = createMockHost();
    host.api.activities.search = vi.fn(async () => ({
      data: [withdrawalActivity({ id: 'A' }), withdrawalActivity({ id: 'B' }), withdrawalActivity({ id: 'C' })],
      meta: { totalRowCount: 3 },
    })) as never;

    const found = await describeWithdrawals(host.api, ['WF-CASH'], ['A', 'C']);
    expect(found.map((r) => r.id).sort()).toEqual(['A', 'C']);
  });
});

describe('findBackfillCandidates', () => {
  it('stages a CREDIT activity whose comment matches a payment keyword', async () => {
    const host = createMockHost();
    host.api.activities.search = vi.fn(async (_p: number, _s: number, filters: { activityTypes: string }) => {
      if (filters.activityTypes === 'CREDIT') return { data: [cardActivity()], meta: { totalRowCount: 1 } };
      return { data: [], meta: { totalRowCount: 0 } };
    }) as never;

    const found = await findBackfillCandidates(host.api, ['WF-CARD'], ['PAYMENT', 'AUTOPAY', 'THANK YOU'], [], [], []);

    expect(found).toEqual([
      {
        sfTransactionId: 'CARD-ACT-1',
        inflowAccountId: 'WF-CARD',
        inflowActivityId: 'CARD-ACT-1',
        inflowActivityType: 'CREDIT',
        amount: '50',
        currency: 'USD',
        postedDate: '2025-08-06',
        comment: 'Online Payment Thank You',
        status: 'pending',
        candidateWithdrawalIds: [],
        backfilled: true,
      },
    ]);
  });

  it('ignores a CREDIT activity whose comment matches no payment keyword', async () => {
    const host = createMockHost();
    host.api.activities.search = vi.fn(async () => ({
      data: [cardActivity({ comment: 'Grocery Store Refund' })],
      meta: { totalRowCount: 1 },
    })) as never;

    const found = await findBackfillCandidates(host.api, ['WF-CARD'], ['PAYMENT', 'AUTOPAY', 'THANK YOU'], [], [], []);

    expect(found).toEqual([]);
  });

  it('skips an activity already resolved to the same inflowActivityId in existing staging', async () => {
    const host = createMockHost();
    host.api.activities.search = vi.fn(async () => ({ data: [cardActivity()], meta: { totalRowCount: 1 } })) as never;

    const found = await findBackfillCandidates(
      host.api,
      ['WF-CARD'],
      ['PAYMENT'],
      [],
      [],
      [candidate({ inflowActivityId: 'CARD-ACT-1' })],
    );

    expect(found).toEqual([]);
  });

  it('skips an activity matching an unresolved existing candidate by amount/date/comment', async () => {
    const host = createMockHost();
    host.api.activities.search = vi.fn(async () => ({ data: [cardActivity()], meta: { totalRowCount: 1 } })) as never;

    const found = await findBackfillCandidates(
      host.api,
      ['WF-CARD'],
      ['PAYMENT'],
      [],
      [],
      [candidate({ inflowActivityId: null, amount: '50', postedDate: '2025-08-06', comment: 'Online Payment Thank You' })],
    );

    expect(found).toEqual([]);
  });

  it('does not skip a same amount/date/comment activity on a different card account', async () => {
    const host = createMockHost();
    host.api.activities.search = vi.fn(async (_p: number, _s: number, filters: { activityTypes: string }) => {
      if (filters.activityTypes === 'CREDIT') {
        return { data: [cardActivity({ id: 'CARD-ACT-OTHER', accountId: 'WF-CARD-2' })], meta: { totalRowCount: 1 } };
      }
      return { data: [], meta: { totalRowCount: 0 } };
    }) as never;

    const found = await findBackfillCandidates(
      host.api,
      ['WF-CARD-2'],
      ['PAYMENT'],
      [],
      [],
      [
        candidate({
          inflowAccountId: 'WF-CARD',
          inflowActivityId: null,
          amount: '50',
          postedDate: '2025-08-06',
          comment: 'Online Payment Thank You',
        }),
      ],
    );

    expect(found).toEqual([
      expect.objectContaining({ sfTransactionId: 'CARD-ACT-OTHER', inflowAccountId: 'WF-CARD-2' }),
    ]);
  });

  it('returns nothing and never searches when no card or cash accounts are given', async () => {
    const host = createMockHost();
    host.api.activities.search = vi.fn();

    const found = await findBackfillCandidates(host.api, [], ['PAYMENT'], [], ['TRANSFER'], []);

    expect(found).toEqual([]);
    expect(host.api.activities.search).not.toHaveBeenCalled();
  });

  it('stages a DEPOSIT activity on a cash account whose comment matches a transfer keyword', async () => {
    const host = createMockHost();
    const depositActivity = cardActivity({
      id: 'DEPOSIT-ACT-1',
      accountId: 'WF-SAVINGS',
      activityType: 'DEPOSIT',
      comment: 'Online Transfer From Checking',
    });
    host.api.activities.search = vi.fn(async (_p: number, _s: number, filters: { activityTypes: string }) => {
      if (filters.activityTypes === 'DEPOSIT') return { data: [depositActivity], meta: { totalRowCount: 1 } };
      return { data: [], meta: { totalRowCount: 0 } };
    }) as never;

    const found = await findBackfillCandidates(host.api, [], ['PAYMENT'], ['WF-SAVINGS'], ['TRANSFER'], []);

    expect(found).toEqual([
      {
        sfTransactionId: 'DEPOSIT-ACT-1',
        inflowAccountId: 'WF-SAVINGS',
        inflowActivityId: 'DEPOSIT-ACT-1',
        inflowActivityType: 'DEPOSIT',
        amount: '50',
        currency: 'USD',
        postedDate: '2025-08-06',
        comment: 'Online Transfer From Checking',
        status: 'pending',
        candidateWithdrawalIds: [],
        backfilled: true,
      },
    ]);
  });

  it('checks the card scan against paymentKeywords only and the cash scan against transferKeywords only', async () => {
    const host = createMockHost();
    host.api.activities.search = vi.fn(async (_p: number, _s: number, filters: { activityTypes: string }) => {
      if (filters.activityTypes === 'CREDIT') {
        // Matches transferKeywords, not paymentKeywords — must not be staged.
        return { data: [cardActivity({ comment: 'Online Transfer From Checking' })], meta: { totalRowCount: 1 } };
      }
      // Matches paymentKeywords, not transferKeywords — must not be staged.
      return {
        data: [cardActivity({ id: 'DEPOSIT-ACT-1', accountId: 'WF-SAVINGS', activityType: 'DEPOSIT', comment: 'Online Payment Thank You' })],
        meta: { totalRowCount: 1 },
      };
    }) as never;

    const found = await findBackfillCandidates(host.api, ['WF-CARD'], ['PAYMENT'], ['WF-SAVINGS'], ['TRANSFER'], []);

    expect(found).toEqual([]);
  });

  it('combines card and cash backfill candidates from a single call', async () => {
    const host = createMockHost();
    const depositActivity = cardActivity({
      id: 'DEPOSIT-ACT-1',
      accountId: 'WF-SAVINGS',
      activityType: 'DEPOSIT',
      comment: 'Online Transfer From Checking',
    });
    host.api.activities.search = vi.fn(async (_p: number, _s: number, filters: { activityTypes: string }) => {
      if (filters.activityTypes === 'CREDIT') return { data: [cardActivity()], meta: { totalRowCount: 1 } };
      return { data: [depositActivity], meta: { totalRowCount: 1 } };
    }) as never;

    const found = await findBackfillCandidates(host.api, ['WF-CARD'], ['PAYMENT'], ['WF-SAVINGS'], ['TRANSFER'], []);

    expect(found.map((c) => c.sfTransactionId).sort()).toEqual(['CARD-ACT-1', 'DEPOSIT-ACT-1']);
  });
});

describe('resolveAmbiguous', () => {
  it('reclassifies the chosen withdrawal and the resolved inflow activity', async () => {
    const host = createMockHost();
    host.api.activities.search = vi.fn(async (_p: number, _s: number, filters: { activityTypes: string }) => {
      if (filters.activityTypes === 'CREDIT') return { data: [cardActivity()], meta: { totalRowCount: 1 } };
      return { data: [withdrawalActivity(), withdrawalActivity({ id: 'OTHER' })], meta: { totalRowCount: 2 } };
    }) as never;

    await resolveAmbiguous(
      host.api,
      candidate({ status: 'ambiguous', inflowActivityId: 'CARD-ACT-1', candidateWithdrawalIds: ['CASH-ACT-1', 'OTHER'] }),
      ['WF-CASH'],
      'CASH-ACT-1',
    );

    expect(host.api.activities.saveMany).toHaveBeenCalledWith({
      creates: [
        expect.objectContaining({ accountId: 'WF-CARD', activityType: 'TRANSFER_IN', sourceGroupId: 'TXN-1' }),
        expect.objectContaining({ accountId: 'WF-CASH', activityType: 'TRANSFER_OUT', sourceGroupId: 'TXN-1' }),
      ],
      deleteIds: ['CARD-ACT-1', 'CASH-ACT-1'],
    });
  });

  it('reclassifies the chosen withdrawal and the resolved deposit activity for a cash-transfer candidate', async () => {
    const host = createMockHost();
    const depositActivity = cardActivity({
      id: 'DEPOSIT-ACT-1',
      accountId: 'WF-CASH-B',
      activityType: 'DEPOSIT',
    });

    host.api.activities.search = vi.fn(async (_p: number, _s: number, filters: { activityTypes: string }) => {
      if (filters.activityTypes === 'DEPOSIT') return { data: [depositActivity], meta: { totalRowCount: 1 } };
      return { data: [withdrawalActivity(), withdrawalActivity({ id: 'OTHER' })], meta: { totalRowCount: 2 } };
    }) as never;

    await resolveAmbiguous(
      host.api,
      candidate({
        inflowAccountId: 'WF-CASH-B',
        inflowActivityType: 'DEPOSIT',
        status: 'ambiguous',
        inflowActivityId: 'DEPOSIT-ACT-1',
        candidateWithdrawalIds: ['CASH-ACT-1', 'OTHER'],
      }),
      ['WF-CASH'],
      'CASH-ACT-1',
    );

    expect(host.api.activities.saveMany).toHaveBeenCalledWith({
      creates: [
        expect.objectContaining({ accountId: 'WF-CASH-B', activityType: 'TRANSFER_IN', sourceGroupId: 'TXN-1' }),
        expect.objectContaining({ accountId: 'WF-CASH', activityType: 'TRANSFER_OUT', sourceGroupId: 'TXN-1' }),
      ],
      deleteIds: ['DEPOSIT-ACT-1', 'CASH-ACT-1'],
    });
  });

  it('throws if the chosen withdrawal can no longer be found', async () => {
    const host = createMockHost();
    host.api.activities.search = vi.fn(async (_p: number, _s: number, filters: { activityTypes: string }) => {
      if (filters.activityTypes === 'CREDIT') return { data: [cardActivity()], meta: { totalRowCount: 1 } };
      return { data: [], meta: { totalRowCount: 0 } };
    }) as never;

    await expect(
      resolveAmbiguous(host.api, candidate({ inflowActivityId: 'CARD-ACT-1' }), ['WF-CASH'], 'GONE'),
    ).rejects.toThrow(/GONE/);
  });
});
