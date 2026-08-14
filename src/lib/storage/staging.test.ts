import { describe, expect, it } from 'vitest';
import { createMockHost } from '../../test/mockHost';
import { readStaging, writeStaging, type StagedCandidate } from './staging';

const candidate = (over: Partial<StagedCandidate> = {}): StagedCandidate => ({
  sfTransactionId: 'TXN-1',
  cardAccountId: 'WF-CARD',
  cardActivityId: null,
  amount: '50.00',
  postedDate: '2026-08-01',
  comment: 'ONLINE PAYMENT THANK YOU',
  status: 'pending',
  candidateWithdrawalIds: [],
  ...over,
});

describe('staging', () => {
  it('returns an empty list when nothing is stored', async () => {
    const host = createMockHost();
    expect(await readStaging(host.api)).toEqual([]);
  });

  it('round-trips the staged candidate list', async () => {
    const host = createMockHost();
    const candidates = [candidate(), candidate({ sfTransactionId: 'TXN-2', status: 'ambiguous', candidateWithdrawalIds: ['A-1', 'A-2'] })];
    await writeStaging(host.api, candidates);
    expect(await readStaging(host.api)).toEqual(candidates);
  });

  it('recovers from a corrupt store rather than throwing', async () => {
    const host = createMockHost();
    await host.api.storage.set('simplefin.staging', '{not json');
    expect(await readStaging(host.api)).toEqual([]);
    expect(host.api.logger.error).toHaveBeenCalled();
  });
});
