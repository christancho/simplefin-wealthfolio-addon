import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { createMockHost } from '../test/mockHost';
import { SyncPage } from './SyncPage';

describe('SyncPage', () => {
  it('shows the setup card when no base URL is configured', async () => {
    const host = createMockHost();
    render(<SyncPage api={host.api} />);
    expect(await screen.findByText(/connect to simplefin/i)).toBeInTheDocument();
  });

  it('claims a token and stores credentials in secrets, not storage', async () => {
    const host = createMockHost();
    host.respond(/\/claim\//, { body: 'https://alice:s3cret@bridge.simplefin.org/simplefin' });
    host.respond(/\/accounts/, { body: JSON.stringify({ accounts: [], errors: [] }) });

    render(<SyncPage api={host.api} />);
    await userEvent.type(
      await screen.findByLabelText(/setup token/i),
      btoa('https://bridge.simplefin.org/simplefin/claim/DEMO'),
    );
    await userEvent.click(screen.getByRole('button', { name: /connect/i }));

    await waitFor(() => expect(host.secrets.get('simplefin.auth')).toBe(btoa('alice:s3cret')));
    // The credential must never reach durable storage.
    expect([...host.storage.values()].join('')).not.toContain('s3cret');
  });

  it('surfaces a claim failure to the user instead of failing silently', async () => {
    const host = createMockHost();
    host.respond(/\/claim\//, { status: 403, body: 'Forbidden' });

    render(<SyncPage api={host.api} />);
    await userEvent.type(await screen.findByLabelText(/setup token/i), btoa('https://x/claim/D'));
    await userEvent.click(screen.getByRole('button', { name: /connect/i }));

    expect(await screen.findByText(/single-use/i)).toBeInTheDocument();
  });

  it('lists SimpleFIN accounts alongside Wealthfolio accounts once connected', async () => {
    const host = createMockHost();
    await host.api.storage.set(
      'simplefin.config',
      JSON.stringify({ baseUrl: 'https://bridge.simplefin.org/simplefin', mappings: [] }),
    );
    host.respond(/\/accounts/, {
      body: JSON.stringify({
        accounts: [{ id: 'ACT-1', name: 'Checking', currency: 'USD', balance: '1.00', 'balance-date': 1, org: { name: 'Bank A' } }],
        errors: [],
      }),
    });
    host.api.accounts.getAll = vi.fn(async () => [{ id: 'WF-1', name: 'My Checking' }] as never);

    render(<SyncPage api={host.api} />);
    expect(await screen.findByText('Checking')).toBeInTheDocument();
    expect(await screen.findByText('Bank A')).toBeInTheDocument();
  });

  it('persists a chosen mapping', async () => {
    const host = createMockHost();
    await host.api.storage.set(
      'simplefin.config',
      JSON.stringify({ baseUrl: 'https://bridge.simplefin.org/simplefin', mappings: [] }),
    );
    host.respond(/\/accounts/, {
      body: JSON.stringify({
        accounts: [{ id: 'ACT-1', name: 'Checking', currency: 'USD', balance: '1.00', 'balance-date': 1, org: { name: 'Bank A' } }],
        errors: [],
      }),
    });
    host.api.accounts.getAll = vi.fn(async () => [{ id: 'WF-1', name: 'My Checking' }] as never);

    render(<SyncPage api={host.api} />);
    await userEvent.selectOptions(await screen.findByLabelText(/map checking/i), 'WF-1');

    await waitFor(() => {
      const config = JSON.parse(host.storage.get('simplefin.config') as string);
      expect(config.mappings).toEqual([
        expect.objectContaining({ sfAccountId: 'ACT-1', wfAccountId: 'WF-1' }),
      ]);
    });
  });

  it('creates a new Wealthfolio account on the spot and auto-maps it', async () => {
    const host = createMockHost();
    await host.api.storage.set(
      'simplefin.config',
      JSON.stringify({ baseUrl: 'https://bridge.simplefin.org/simplefin', mappings: [] }),
    );
    host.respond(/\/accounts/, {
      body: JSON.stringify({
        accounts: [{ id: 'ACT-1', name: 'Checking', currency: 'USD', balance: '1.00', 'balance-date': 1, org: { name: 'Bank A' } }],
        errors: [],
      }),
    });
    host.api.accounts.getAll = vi.fn(async () => [] as never);
    host.api.accounts.create = vi.fn(async () => ({ id: 'WF-NEW', name: 'Bank A Checking' }) as never);

    render(<SyncPage api={host.api} />);
    await userEvent.selectOptions(await screen.findByLabelText(/map checking/i), '__create__');

    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: /create/i }));

    await waitFor(() => expect(host.api.accounts.create).toHaveBeenCalled());
    await waitFor(() => {
      const config = JSON.parse(host.storage.get('simplefin.config') as string);
      expect(config.mappings).toEqual([
        expect.objectContaining({ sfAccountId: 'ACT-1', wfAccountId: 'WF-NEW' }),
      ]);
    });
  });

  it('surfaces an error and keeps the previous state when persisting a mapping fails', async () => {
    const host = createMockHost();
    await host.api.storage.set(
      'simplefin.config',
      JSON.stringify({ baseUrl: 'https://bridge.simplefin.org/simplefin', mappings: [] }),
    );
    host.respond(/\/accounts/, {
      body: JSON.stringify({
        accounts: [{ id: 'ACT-1', name: 'Checking', currency: 'USD', balance: '1.00', 'balance-date': 1, org: { name: 'Bank A' } }],
        errors: [],
      }),
    });
    host.api.accounts.getAll = vi.fn(async () => [{ id: 'WF-1', name: 'My Checking' }] as never);
    host.api.storage.set = vi.fn(async () => {
      throw new Error('storage unavailable');
    });

    render(<SyncPage api={host.api} />);
    await userEvent.selectOptions(await screen.findByLabelText(/map checking/i), 'WF-1');

    expect(await screen.findByText(/storage unavailable/i)).toBeInTheDocument();
    expect(await screen.findByLabelText(/map checking/i)).toHaveValue('');
  });

  it('surfaces an error instead of staying blank when the initial config read fails', async () => {
    const host = createMockHost();
    host.api.storage.get = vi.fn(async () => {
      throw new Error('storage unavailable');
    });

    render(<SyncPage api={host.api} />);

    expect(await screen.findByText(/storage unavailable/i)).toBeInTheDocument();
  });
});
