import type { ActivityImport } from '@wealthfolio/addon-sdk';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { createMockHost } from '../test/mockHost';
import { appendRun } from '../lib/storage/history';
import { writeWatermark } from '../lib/storage/watermark';
import { SyncPage } from './SyncPage';

function seedConfig(host: ReturnType<typeof createMockHost>, mappings: unknown[]) {
  host.storage.set(
    'simplefin.config',
    JSON.stringify({ baseUrl: 'https://bridge.simplefin.org/simplefin', mappings }),
  );
}

const CHECKING_MAPPING = {
  sfAccountId: 'ACT-1',
  wfAccountId: 'WF-1',
  mode: 'CASH',
  sfAccountName: 'Checking',
  orgName: 'Bank A',
};

describe('SyncPage sync trigger', () => {
  it('calls runSync and renders per-account imported counts', async () => {
    const host = createMockHost();
    seedConfig(host, [CHECKING_MAPPING]);
    host.respond(/\/accounts/, {
      body: JSON.stringify({
        accounts: [
          {
            id: 'ACT-1',
            name: 'Checking',
            currency: 'USD',
            balance: '100.00',
            'balance-date': 1700000000,
            org: { name: 'Bank A' },
            transactions: [
              { id: 'TXN-1', posted: 1700000000, amount: '-12.34', description: 'Coffee', payee: 'Cafe', memo: null, pending: false },
            ],
          },
        ],
        errors: [],
      }),
    });
    host.api.accounts.getAll = vi.fn(async () => [{ id: 'WF-1', name: 'My Checking', balance: 100 }] as never);
    host.api.activities.checkImport = vi.fn(async (rows: ActivityImport[]) => rows.map((r) => ({ ...r, isValid: true })) as never);
    host.api.activities.import = vi.fn(
      async () =>
        ({ activities: [], importRunId: 'run1', summary: { total: 1, imported: 1, skipped: 0, duplicates: 0, assetsCreated: 0, success: true } }) as never,
    );

    render(<SyncPage api={host.api} />);
    await screen.findByText('Checking');
    await userEvent.click(screen.getByRole('button', { name: /sync now/i }));
    await userEvent.click(await screen.findByRole('tab', { name: /summary/i }));

    const resultsTable = await screen.findByRole('table', { name: /sync results/i });
    const row = within(resultsTable).getByText('Checking').closest('tr');
    expect(row).not.toBeNull();
    const cells = within(row as HTMLElement)
      .getAllByRole('cell')
      .map((c) => c.textContent);
    expect(cells).toEqual(['Checking', '1', '0', '0', '1', '—']);
  });

  it('renders a per-account error as failed while other accounts show success', async () => {
    const host = createMockHost();
    const secondMapping = {
      sfAccountId: 'ACT-2',
      wfAccountId: 'WF-2',
      mode: 'CASH',
      sfAccountName: 'Savings',
      orgName: 'Bank B',
    };
    seedConfig(host, [CHECKING_MAPPING, secondMapping]);
    host.respond(/\/accounts/, {
      // ACT-2 is absent from the Bridge response, so its sync fails automatically.
      body: JSON.stringify({
        accounts: [
          {
            id: 'ACT-1',
            name: 'Checking',
            currency: 'USD',
            balance: '100.00',
            'balance-date': 1700000000,
            org: { name: 'Bank A' },
            transactions: [],
          },
        ],
        errors: [],
      }),
    });
    host.api.accounts.getAll = vi.fn(async () => [
      { id: 'WF-1', name: 'My Checking', balance: 100 },
      { id: 'WF-2', name: 'My Savings', balance: 0 },
    ] as never);

    render(<SyncPage api={host.api} />);
    await screen.findByText('Checking');
    await userEvent.click(screen.getByRole('button', { name: /sync now/i }));
    await userEvent.click(await screen.findByRole('tab', { name: /summary/i }));

    const resultsTable = await screen.findByRole('table', { name: /sync results/i });
    expect(await within(resultsTable).findByText(/was not returned by the bridge/i)).toBeInTheDocument();

    const okRow = within(resultsTable).getByText('Checking').closest('tr');
    const okCells = within(okRow as HTMLElement)
      .getAllByRole('cell')
      .map((c) => c.textContent);
    expect(okCells).toEqual(['Checking', '0', '0', '0', '0', '—']);
  });

  it('renders a bridge error banner naming the institution with a link to the credential-free dashboard host', async () => {
    const host = createMockHost();
    seedConfig(host, []);
    host.respond(/\/accounts/, {
      body: JSON.stringify({
        accounts: [],
        errlist: [{ code: 'x', msg: 'Bank of Example connection has expired', conn_id: 'conn1' }],
      }),
    });

    render(<SyncPage api={host.api} />);
    await userEvent.click(await screen.findByRole('button', { name: /sync now/i }));

    expect(await screen.findByText(/bank of example connection has expired/i)).toBeInTheDocument();
    const link = screen.getByRole('link', { name: /open simplefin bridge/i });
    expect(link).toHaveAttribute('href', 'https://bridge.simplefin.org');
  });

  it('renders both figures for an account with a balance mismatch', async () => {
    const host = createMockHost();
    seedConfig(host, [CHECKING_MAPPING]);
    // Already synced: a first-sync mismatch is now auto-plugged rather than
    // left as a standing mismatch, so this steady-state UI check needs an
    // account past its first sync to exercise the mismatch path at all.
    await writeWatermark(host.api, 'ACT-1', { lastPosted: 1700000000 - 86_400, recentIds: [] });
    host.respond(/\/accounts/, {
      body: JSON.stringify({
        accounts: [
          {
            id: 'ACT-1',
            name: 'Checking',
            currency: 'USD',
            balance: '150.00',
            'balance-date': 1700000000,
            org: { name: 'Bank A' },
            transactions: [],
          },
        ],
        errors: [],
      }),
    });
    host.api.accounts.getAll = vi.fn(async () => [{ id: 'WF-1', name: 'My Checking', balance: 100 }] as never);

    render(<SyncPage api={host.api} />);
    await screen.findByText('Checking');
    await userEvent.click(screen.getByRole('button', { name: /sync now/i }));
    await userEvent.click(await screen.findByRole('tab', { name: /summary/i }));

    const resultsTable = await screen.findByRole('table', { name: /sync results/i });
    expect(await within(resultsTable).findByText(/simplefin 150\.00 vs wealthfolio 100/i)).toBeInTheDocument();
  });

  it('disables the sync button while a run is in flight', async () => {
    const host = createMockHost();
    seedConfig(host, [CHECKING_MAPPING]);
    host.respond(/\/accounts/, {
      body: JSON.stringify({
        accounts: [
          { id: 'ACT-1', name: 'Checking', currency: 'USD', balance: '100.00', 'balance-date': 1700000000, org: { name: 'Bank A' }, transactions: [] },
        ],
        errors: [],
      }),
    });
    host.api.accounts.getAll = vi.fn(async () => [{ id: 'WF-1', name: 'My Checking', balance: 100 }] as never);

    render(<SyncPage api={host.api} />);
    await screen.findByText('Checking');

    let resolveRequest!: (value: { status: number; headers: Record<string, string>; body: string }) => void;
    const pending = new Promise<{ status: number; headers: Record<string, string>; body: string }>((resolve) => {
      resolveRequest = resolve;
    });
    host.api.network.request = vi.fn(() => pending) as never;

    const button = screen.getByRole('button', { name: /sync now/i });
    await userEvent.click(button);

    expect(button).toBeDisabled();

    resolveRequest({ status: 200, headers: {}, body: JSON.stringify({ accounts: [], errors: [] }) });

    await waitFor(() => expect(button).toBeEnabled());
  });

  it('renders history newest-first after a completed run', async () => {
    const host = createMockHost();
    seedConfig(host, [CHECKING_MAPPING]);
    await appendRun(host.api, {
      startedAt: '2026-01-01T00:00:00.000Z',
      finishedAt: '2026-01-01T00:00:01.000Z',
      accounts: [
        {
          sfAccountId: 'ACT-OLD',
          sfAccountName: 'Old',
          orgName: 'Old Bank',
          wfAccountId: 'WF-OLD',
          mode: 'CASH',
          imported: 3,
          skipped: 0,
          duplicates: 0,
          error: null,
          balanceMismatch: null,
        },
      ],
      bridgeErrors: [],
    });
    host.respond(/\/accounts/, {
      body: JSON.stringify({
        accounts: [
          {
            id: 'ACT-1',
            name: 'Checking',
            currency: 'USD',
            balance: '100.00',
            'balance-date': 1700000000,
            org: { name: 'Bank A' },
            transactions: [{ id: 'TXN-1', posted: 1700000000, amount: '-1.00', description: 'x', payee: null, memo: null, pending: false }],
          },
        ],
        errors: [],
      }),
    });
    host.api.accounts.getAll = vi.fn(async () => [{ id: 'WF-1', name: 'My Checking', balance: 100 }] as never);
    host.api.activities.checkImport = vi.fn(async (rows: ActivityImport[]) => rows.map((r) => ({ ...r, isValid: true })) as never);
    host.api.activities.import = vi.fn(
      async () =>
        ({ activities: [], importRunId: 'run2', summary: { total: 1, imported: 2, skipped: 0, duplicates: 0, assetsCreated: 0, success: true } }) as never,
    );

    render(<SyncPage api={host.api} />);
    await screen.findByText('Checking');
    await userEvent.click(screen.getByRole('button', { name: /sync now/i }));
    await userEvent.click(await screen.findByRole('tab', { name: /runs/i }));

    const historyTable = await screen.findByRole('table', { name: /sync history/i });
    const rows = within(historyTable).getAllByRole('row').slice(1); // drop header row
    expect(rows).toHaveLength(2);
    expect(within(rows[0]).getAllByRole('cell')[1].textContent).toBe('2');
    expect(within(rows[1]).getAllByRole('cell')[1].textContent).toBe('3');
  });

  it('surfaces a thrown runSync as a visible error and re-enables the button', async () => {
    const host = createMockHost();
    seedConfig(host, []);
    host.respond(/\/accounts/, { body: JSON.stringify({ accounts: [], errors: [] }) });
    host.api.storage.set = vi.fn(async () => {
      throw new Error('history storage unavailable');
    });

    render(<SyncPage api={host.api} />);
    const button = await screen.findByRole('button', { name: /sync now/i });
    await userEvent.click(button);

    expect(await screen.findByText(/history storage unavailable/i)).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: /sync now/i })).toBeEnabled();
  });
});
