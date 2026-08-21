import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { createMockHost } from '../test/mockHost';
import { writeStaging, type StagedCandidate } from '../lib/storage/staging';
import { StagedTransactionsList } from './StagedTransactionsList';

const pending: StagedCandidate = {
  sfTransactionId: 'TXN-1',
  cardAccountId: 'WF-CARD',
  cardActivityId: null,
  amount: '50.00',
  currency: 'USD',
  postedDate: '2026-08-01',
  comment: 'Online Payment Thank You',
  status: 'pending',
  candidateWithdrawalIds: [],
};

const ambiguous: StagedCandidate = {
  sfTransactionId: 'TXN-2',
  cardAccountId: 'WF-CARD',
  cardActivityId: 'CARD-ACT-2',
  amount: '80.00',
  currency: 'USD',
  postedDate: '2026-08-02',
  comment: 'Autopay',
  status: 'ambiguous',
  candidateWithdrawalIds: ['CASH-A', 'CASH-B'],
};

const defaultProps = {
  cashAccountIds: ['WF-CASH'],
  cardAccountIds: ['WF-CARD'],
  paymentKeywords: ['PAYMENT', 'AUTOPAY', 'THANK YOU'],
  wfAccounts: [] as never,
};

describe('StagedTransactionsList', () => {
  it('shows a message when there is nothing staged', async () => {
    const host = createMockHost();
    render(<StagedTransactionsList api={host.api} {...defaultProps} />);
    expect(await screen.findByText(/no staged transactions/i)).toBeInTheDocument();
  });

  it('surfaces a visible error when loading staged candidates fails', async () => {
    const host = createMockHost();
    host.api.storage.get = vi.fn(async () => {
      throw new Error('storage unavailable');
    }) as never;

    render(<StagedTransactionsList api={host.api} {...defaultProps} />);

    expect(await screen.findByText(/storage unavailable/i)).toBeInTheDocument();
  });

  it('lists pending and ambiguous candidates with their amount, date and comment', async () => {
    const host = createMockHost();
    await writeStaging(host.api, [pending, ambiguous]);

    render(<StagedTransactionsList api={host.api} {...defaultProps} />);

    expect(await screen.findByText('$50.00')).toBeInTheDocument();
    expect(screen.getByText('Online Payment Thank You')).toBeInTheDocument();
    expect(screen.getByText('2026-08-01')).toBeInTheDocument();
    expect(screen.getByText('$80.00')).toBeInTheDocument();
    expect(screen.getByText('Autopay')).toBeInTheDocument();
    expect(screen.getByText('2026-08-02')).toBeInTheDocument();
  });

  it('orders the staged table columns as date, comment, status, amount, action', async () => {
    const host = createMockHost();
    await writeStaging(host.api, [pending]);

    render(<StagedTransactionsList api={host.api} {...defaultProps} />);

    const headers = await screen.findAllByRole('columnheader');
    expect(headers.map((h) => h.textContent)).toEqual(['Date', 'Comment', 'Status', 'Amount', 'Action']);
  });

  it('groups staged candidates under a header naming each credit-card account', async () => {
    const host = createMockHost();
    await writeStaging(host.api, [
      { ...pending, sfTransactionId: 'TXN-A', cardAccountId: 'WF-CARD-A', comment: 'Chase Payment' },
      { ...pending, sfTransactionId: 'TXN-B', cardAccountId: 'WF-CARD-B', comment: 'Amex Payment' },
    ]);

    render(
      <StagedTransactionsList
        api={host.api}
        {...defaultProps}
        wfAccounts={
          [
            { id: 'WF-CARD-A', name: 'Chase Sapphire' },
            { id: 'WF-CARD-B', name: 'Amex Gold' },
          ] as never
        }
      />,
    );

    expect(await screen.findByText(/chase sapphire \(1\)/i)).toBeInTheDocument();
    expect(screen.getByText(/amex gold \(1\)/i)).toBeInTheDocument();
    const chaseGroup = screen.getByText(/chase sapphire \(1\)/i).closest('tr') as HTMLElement;
    const amexGroup = screen.getByText(/amex gold \(1\)/i).closest('tr') as HTMLElement;
    expect(within(chaseGroup.nextElementSibling as HTMLElement).getByText('Chase Payment')).toBeInTheDocument();
    expect(within(amexGroup.nextElementSibling as HTMLElement).getByText('Amex Payment')).toBeInTheDocument();
  });

  it('dismisses a pending candidate without calling the host activities API', async () => {
    const host = createMockHost();
    await writeStaging(host.api, [pending]);

    render(<StagedTransactionsList api={host.api} {...defaultProps} />);
    await userEvent.click(await screen.findByRole('button', { name: /dismiss/i }));

    expect(await screen.findByText(/no staged transactions/i)).toBeInTheDocument();
    expect(host.api.activities.saveMany).not.toHaveBeenCalled();
    expect(host.storage.get('simplefin.staging')).toBe('[]');
  });

  it('shows a picker for an ambiguous candidate as a table of account/description/amount and resolves the chosen withdrawal', async () => {
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
          { id: 'CASH-A', accountId: 'WF-CASH', accountName: 'Joint Checking', activityType: 'WITHDRAWAL', date: '2026-07-31T00:00:00+00:00', amount: '80', currency: 'USD', comment: 'Bill Pay A' },
          { id: 'CASH-B', accountId: 'WF-CASH-2', accountName: 'Personal Checking', activityType: 'WITHDRAWAL', date: '2026-07-30T00:00:00+00:00', amount: '80', currency: 'USD', comment: 'Bill Pay B' },
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

    render(<StagedTransactionsList api={host.api} {...defaultProps} />);

    const row = (await screen.findByText('Autopay')).closest('tr') as HTMLElement;
    await userEvent.click(within(row).getByRole('button', { name: /resolve/i }));

    const dialog = await screen.findByRole('dialog');
    const table = within(dialog).getByRole('table');
    expect(within(table).getByRole('columnheader', { name: /account/i })).toBeInTheDocument();
    expect(within(table).getByRole('columnheader', { name: /description/i })).toBeInTheDocument();
    expect(within(table).getByRole('columnheader', { name: /date/i })).toBeInTheDocument();
    expect(within(table).getByRole('columnheader', { name: /amount/i })).toBeInTheDocument();
    expect(within(table).getByText('Joint Checking')).toBeInTheDocument();
    expect(within(table).getByText('Personal Checking')).toBeInTheDocument();
    expect(within(table).getByText('2026-07-31')).toBeInTheDocument();
    expect(within(table).getByText('2026-07-30')).toBeInTheDocument();
    expect(within(table).getAllByText('$80.00')).toHaveLength(2);

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

  it('scans existing activities and stages a keyword match with no withdrawal pair yet', async () => {
    const host = createMockHost();
    host.api.activities.search = vi.fn(async (_p: number, _s: number, filters: { activityTypes: string }) => {
      if (filters.activityTypes === 'CREDIT') {
        return {
          data: [
            {
              id: 'OLD-CARD-ACT',
              accountId: 'WF-CARD',
              activityType: 'CREDIT',
              date: '2026-06-01T00:00:00+00:00',
              amount: '75.00',
              currency: 'USD',
              comment: 'Online Payment Thank You',
            },
          ],
          meta: { totalRowCount: 1 },
        };
      }
      return { data: [], meta: { totalRowCount: 0 } };
    }) as never;

    render(<StagedTransactionsList api={host.api} {...defaultProps} />);
    await screen.findByText(/no staged transactions/i);

    await userEvent.click(screen.getByRole('button', { name: /scan for older payments/i }));

    expect(await screen.findByText('$75.00')).toBeInTheDocument();
    expect(screen.getByText('pending')).toBeInTheDocument();
    expect(host.storage.get('simplefin.staging')).toContain('OLD-CARD-ACT');
  });

  it('immediately resolves a scanned candidate when a matching withdrawal already exists', async () => {
    const host = createMockHost();
    host.api.activities.search = vi.fn(async (_p: number, _s: number, filters: { activityTypes: string }) => {
      if (filters.activityTypes === 'CREDIT') {
        return {
          data: [
            {
              id: 'OLD-CARD-ACT',
              accountId: 'WF-CARD',
              activityType: 'CREDIT',
              date: '2026-06-01T00:00:00+00:00',
              amount: '75.00',
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
            id: 'OLD-CASH-ACT',
            accountId: 'WF-CASH',
            activityType: 'WITHDRAWAL',
            date: '2026-05-31T00:00:00+00:00',
            amount: '75.00',
            currency: 'USD',
            comment: 'Bill Pay',
          },
        ],
        meta: { totalRowCount: 1 },
      };
    }) as never;

    render(<StagedTransactionsList api={host.api} {...defaultProps} />);
    await screen.findByText(/no staged transactions/i);

    await userEvent.click(screen.getByRole('button', { name: /scan for older payments/i }));

    expect(await screen.findByText(/no staged transactions/i)).toBeInTheDocument();
    expect(host.api.activities.saveMany).toHaveBeenCalledWith({
      updates: [
        expect.objectContaining({ id: 'OLD-CARD-ACT', activityType: 'TRANSFER_IN' }),
        expect.objectContaining({ id: 'OLD-CASH-ACT', activityType: 'TRANSFER_OUT' }),
      ],
    });
  });
});
