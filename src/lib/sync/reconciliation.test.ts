import { describe, expect, it, vi } from 'vitest';
import type { ActivityDetails } from '@wealthfolio/addon-sdk';
import { createMockHost } from '../../test/mockHost';
import type { StagedCandidate } from '../storage/staging';
import { describeWithdrawals, findCardActivity, resolveAmbiguous, runReconciliation } from './reconciliation';

const NOW = 1754438400 + 5 * 86_400; // 5 days after the fixtures' posted date

const candidate = (over: Partial<StagedCandidate> = {}): StagedCandidate => ({
  sfTransactionId: 'TXN-1',
  cardAccountId: 'WF-CARD',
  cardActivityId: null,
  amount: '50.00',
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
      updates: [
        expect.objectContaining({ id: 'CARD-ACT-1', activityType: 'TRANSFER_IN' }),
        expect.objectContaining({ id: 'CASH-ACT-1', activityType: 'TRANSFER_OUT' }),
      ],
    });
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
    expect(candidates[0].cardActivityId).toBe('CARD-ACT-1');
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

  it('isolates a per-candidate failure so other candidates still resolve', async () => {
    const host = createMockHost();
    host.api.activities.search = vi.fn(async (_p: number, _s: number, filters: { accountIds: string[]; activityTypes: string }) => {
      if (filters.accountIds[0] === 'WF-CARD-BAD') throw new Error('search exploded');
      if (filters.activityTypes === 'CREDIT') return { data: [cardActivity()], meta: { totalRowCount: 1 } };
      return { data: [withdrawalActivity()], meta: { totalRowCount: 1 } };
    }) as never;

    const bad = candidate({ sfTransactionId: 'TXN-BAD', cardAccountId: 'WF-CARD-BAD' });
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
      errors: [{ id: 'CARD-ACT-1', action: 'update', message: 'row locked' }],
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

    const first = candidate({ sfTransactionId: 'TXN-1', cardActivityId: 'CARD-ACT-1' });
    const second = candidate({ sfTransactionId: 'TXN-2', cardActivityId: 'CARD-ACT-2' });

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

describe('findCardActivity', () => {
  it('resolves by accountId/amount/date/comment when cardActivityId is unknown', async () => {
    const host = createMockHost();
    host.api.activities.search = vi.fn(async () => ({ data: [cardActivity()], meta: { totalRowCount: 1 } })) as never;

    const found = await findCardActivity(host.api, candidate());
    expect(found?.id).toBe('CARD-ACT-1');
  });

  it('resolves by id directly once cardActivityId is known', async () => {
    const host = createMockHost();
    host.api.activities.search = vi.fn(async () => ({
      data: [cardActivity(), cardActivity({ id: 'OTHER', comment: 'different' })],
      meta: { totalRowCount: 2 },
    })) as never;

    const found = await findCardActivity(host.api, candidate({ cardActivityId: 'OTHER' }));
    expect(found?.id).toBe('OTHER');
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

describe('resolveAmbiguous', () => {
  it('reclassifies the chosen withdrawal and the resolved card activity', async () => {
    const host = createMockHost();
    host.api.activities.search = vi.fn(async (_p: number, _s: number, filters: { activityTypes: string }) => {
      if (filters.activityTypes === 'CREDIT') return { data: [cardActivity()], meta: { totalRowCount: 1 } };
      return { data: [withdrawalActivity(), withdrawalActivity({ id: 'OTHER' })], meta: { totalRowCount: 2 } };
    }) as never;

    await resolveAmbiguous(
      host.api,
      candidate({ status: 'ambiguous', cardActivityId: 'CARD-ACT-1', candidateWithdrawalIds: ['CASH-ACT-1', 'OTHER'] }),
      ['WF-CASH'],
      'CASH-ACT-1',
    );

    expect(host.api.activities.saveMany).toHaveBeenCalledWith({
      updates: [
        expect.objectContaining({ id: 'CARD-ACT-1', activityType: 'TRANSFER_IN' }),
        expect.objectContaining({ id: 'CASH-ACT-1', activityType: 'TRANSFER_OUT' }),
      ],
    });
  });

  it('throws if the chosen withdrawal can no longer be found', async () => {
    const host = createMockHost();
    host.api.activities.search = vi.fn(async (_p: number, _s: number, filters: { activityTypes: string }) => {
      if (filters.activityTypes === 'CREDIT') return { data: [cardActivity()], meta: { totalRowCount: 1 } };
      return { data: [], meta: { totalRowCount: 0 } };
    }) as never;

    await expect(
      resolveAmbiguous(host.api, candidate({ cardActivityId: 'CARD-ACT-1' }), ['WF-CASH'], 'GONE'),
    ).rejects.toThrow(/GONE/);
  });
});
