import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { createMockHost } from '../test/mockHost';
import type { SfAccount } from '../lib/simplefin/parse';
import { CreateAccountDialog } from './CreateAccountDialog';

const CASH_ACCOUNT: SfAccount = {
  id: 'ACT-1',
  name: 'Checking',
  currency: 'USD',
  balance: '100.00',
  balanceDate: 0,
  orgName: 'Bank A',
  transactions: [],
  holdings: [],
};

const HOLDINGS_ACCOUNT: SfAccount = {
  ...CASH_ACCOUNT,
  id: 'ACT-2',
  name: 'Brokerage',
  holdings: [
    {
      symbol: 'VOO',
      shares: '1',
      currency: 'USD',
      costBasis: null,
      purchasePrice: null,
      marketValue: '100',
    },
  ],
};

describe('CreateAccountDialog', () => {
  it('prefills name, currency and type from a cash SimpleFIN account', async () => {
    const host = createMockHost();
    render(
      <CreateAccountDialog
        api={host.api}
        sfAccount={CASH_ACCOUNT}
        onOpenChange={vi.fn()}
        onCreated={vi.fn()}
      />,
    );

    expect(screen.getByLabelText(/name/i)).toHaveValue('Bank A Checking');
    expect(screen.getByLabelText(/currency/i)).toHaveValue('USD');
    expect(screen.getByLabelText(/account type/i)).toHaveValue('CASH');
    expect(screen.getByLabelText(/tracking mode/i)).toHaveValue('TRANSACTIONS');
  });

  it('prefills SECURITIES/HOLDINGS when the SimpleFIN account reports holdings', async () => {
    const host = createMockHost();
    render(
      <CreateAccountDialog
        api={host.api}
        sfAccount={HOLDINGS_ACCOUNT}
        onOpenChange={vi.fn()}
        onCreated={vi.fn()}
      />,
    );

    expect(screen.getByLabelText(/account type/i)).toHaveValue('SECURITIES');
    expect(screen.getByLabelText(/tracking mode/i)).toHaveValue('HOLDINGS');
  });

  it('surfaces a create failure without calling onCreated', async () => {
    const host = createMockHost();
    host.api.accounts.create = vi.fn(async () => {
      throw new Error('account name already in use');
    });
    const onCreated = vi.fn();

    render(
      <CreateAccountDialog
        api={host.api}
        sfAccount={CASH_ACCOUNT}
        onOpenChange={vi.fn()}
        onCreated={onCreated}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: /create/i }));

    expect(await screen.findByText(/account name already in use/i)).toBeInTheDocument();
    expect(onCreated).not.toHaveBeenCalled();
  });
});
