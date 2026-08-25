import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { createMockHost } from '../test/mockHost';
import { writeStaging, type StagedCandidate } from '../lib/storage/staging';
import { StagedTransactionsList } from './StagedTransactionsList';

const pending: StagedCandidate = {
  sfTransactionId: 'TXN-1',
  inflowAccountId: 'WF-CARD',
  inflowActivityId: null,
  inflowActivityType: 'CREDIT',
  amount: '50.00',
  postedDate: '2026-08-01',
  comment: 'Online Payment Thank You',
  status: 'pending',
  candidateWithdrawalIds: [],
};

const ambiguous: StagedCandidate = {
  sfTransactionId: 'TXN-2',
  inflowAccountId: 'WF-CARD',
  inflowActivityId: 'CARD-ACT-2',
  inflowActivityType: 'CREDIT',
  amount: '80.00',
  postedDate: '2026-08-02',
  comment: 'Autopay',
  status: 'ambiguous',
  candidateWithdrawalIds: ['CASH-A', 'CASH-B'],
};

describe('StagedTransactionsList', () => {
  it('shows a message when there is nothing staged', async () => {
    const host = createMockHost();
    render(<StagedTransactionsList api={host.api} cashAccountIds={['WF-CASH']} />);
    expect(await screen.findByText(/no staged transactions/i)).toBeInTheDocument();
  });

  it('surfaces a visible error when loading staged candidates fails', async () => {
    const host = createMockHost();
    host.api.storage.get = vi.fn(async () => {
      throw new Error('storage unavailable');
    }) as never;

    render(<StagedTransactionsList api={host.api} cashAccountIds={['WF-CASH']} />);

    expect(await screen.findByText(/storage unavailable/i)).toBeInTheDocument();
  });

  it('lists pending and ambiguous candidates with their amount and comment', async () => {
    const host = createMockHost();
    await writeStaging(host.api, [pending, ambiguous]);

    render(<StagedTransactionsList api={host.api} cashAccountIds={['WF-CASH']} />);

    expect(await screen.findByText('50.00')).toBeInTheDocument();
    expect(screen.getByText('Online Payment Thank You')).toBeInTheDocument();
    expect(screen.getByText('80.00')).toBeInTheDocument();
    expect(screen.getByText('Autopay')).toBeInTheDocument();
  });

  it('dismisses a pending candidate without calling the host activities API', async () => {
    const host = createMockHost();
    await writeStaging(host.api, [pending]);

    render(<StagedTransactionsList api={host.api} cashAccountIds={['WF-CASH']} />);
    await userEvent.click(await screen.findByRole('button', { name: /dismiss/i }));

    expect(await screen.findByText(/no staged transactions/i)).toBeInTheDocument();
    expect(host.api.activities.saveMany).not.toHaveBeenCalled();
    expect(host.storage.get('simplefin.staging')).toBe('[]');
  });

  it('shows a picker for an ambiguous candidate and resolves the chosen withdrawal', async () => {
    const host = createMockHost();
    await writeStaging(host.api, [ambiguous]);
    host.api.activities.search = vi.fn(async (_p: number, _s: number, filters: { activityTypes: string }) => {
      if (filters.activityTypes === 'CREDIT') {
        return {
          data: [{ id: 'CARD-ACT-2', accountId: 'WF-CARD', activityType: 'CREDIT', date: '2026-08-02T00:00:00+00:00', amount: '80', currency: 'USD', comment: 'Autopay' }],
          meta: { totalRowCount: 1 },
        };
      }
      return {
        data: [
          { id: 'CASH-A', accountId: 'WF-CASH', activityType: 'WITHDRAWAL', date: '2026-07-31T00:00:00+00:00', amount: '80', currency: 'USD', comment: 'Bill Pay A' },
          { id: 'CASH-B', accountId: 'WF-CASH', activityType: 'WITHDRAWAL', date: '2026-07-30T00:00:00+00:00', amount: '80', currency: 'USD', comment: 'Bill Pay B' },
        ],
        meta: { totalRowCount: 2 },
      };
    }) as never;
    host.api.activities.saveMany = vi.fn(async (req) => ({
      created: [],
      updated: req.updates ?? [],
      deleted: [],
      createdMappings: [],
      errors: [],
    })) as never;

    render(<StagedTransactionsList api={host.api} cashAccountIds={['WF-CASH']} />);

    const row = (await screen.findByText('Autopay')).closest('tr') as HTMLElement;
    await userEvent.click(within(row).getByRole('button', { name: /resolve/i }));

    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByText(/bill pay a/i));
    await userEvent.click(within(dialog).getByRole('button', { name: /confirm/i }));

    expect(host.api.activities.saveMany).toHaveBeenCalledWith({
      updates: [
        expect.objectContaining({ id: 'CARD-ACT-2', activityType: 'TRANSFER_IN' }),
        expect.objectContaining({ id: 'CASH-A', activityType: 'TRANSFER_OUT' }),
      ],
    });
    expect(await screen.findByText(/no staged transactions/i)).toBeInTheDocument();
  });
});
