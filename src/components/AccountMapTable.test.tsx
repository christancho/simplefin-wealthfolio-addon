import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { createMockHost } from '../test/mockHost';
import type { SfAccount } from '../lib/simplefin/parse';
import { AccountMapTable } from './AccountMapTable';

function sfAccount(overrides: Partial<SfAccount>): SfAccount {
  return {
    id: 'ACT-1',
    name: 'Checking',
    currency: 'USD',
    balance: '100.00',
    balanceDate: 0,
    orgName: 'Bank A',
    transactions: [],
    holdings: [],
    ...overrides,
  };
}

const CHECKING = sfAccount({ id: 'ACT-1', name: 'Checking', orgName: 'Bank A' });
const SAVINGS = sfAccount({ id: 'ACT-2', name: 'Savings', orgName: 'Bank A' });
const BROKERAGE = sfAccount({ id: 'ACT-3', name: 'Brokerage', orgName: 'Bank B' });

describe('AccountMapTable', () => {
  it('groups accounts under their institution with an account count', async () => {
    const host = createMockHost();
    render(
      <AccountMapTable
        api={host.api}
        sfAccounts={[CHECKING, SAVINGS, BROKERAGE]}
        wfAccounts={[]}
        mappings={[]}
        onChange={vi.fn()}
        onAccountCreated={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: /bank a.*\(2\)/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /bank b.*\(1\)/i })).toBeInTheDocument();
    expect(screen.getByText('Checking')).toBeInTheDocument();
    expect(screen.getByText('Savings')).toBeInTheDocument();
    expect(screen.getByText('Brokerage')).toBeInTheDocument();
  });

  it('collapses and re-expands an institution group on click', async () => {
    const host = createMockHost();
    render(
      <AccountMapTable
        api={host.api}
        sfAccounts={[CHECKING, SAVINGS, BROKERAGE]}
        wfAccounts={[]}
        mappings={[]}
        onChange={vi.fn()}
        onAccountCreated={vi.fn()}
      />,
    );

    const bankAToggle = screen.getByRole('button', { name: /bank a.*\(2\)/i });
    expect(bankAToggle).toHaveAttribute('aria-expanded', 'true');

    await userEvent.click(bankAToggle);
    expect(bankAToggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('Checking')).not.toBeInTheDocument();
    expect(screen.queryByText('Savings')).not.toBeInTheDocument();
    // Bank B is a separate group and stays expanded.
    expect(screen.getByText('Brokerage')).toBeInTheDocument();

    await userEvent.click(bankAToggle);
    expect(bankAToggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Checking')).toBeInTheDocument();
    expect(screen.getByText('Savings')).toBeInTheDocument();
  });
});
