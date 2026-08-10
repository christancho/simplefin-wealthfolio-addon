import { describe, expect, it } from 'vitest';
import { parseAccountsResponse } from './parse';

const payload = {
  errors: [],
  accounts: [
    {
      org: { name: 'Test Bank', domain: 'testbank.com' },
      id: 'ACT-1',
      name: 'Checking',
      currency: 'USD',
      balance: '1234.56',
      'balance-date': 1754524800,
      transactions: [
        {
          id: 'TXN-1',
          posted: 1754438400,
          amount: '-42.10',
          description: 'COFFEE',
          payee: 'Blue Bottle',
          memo: null,
        },
        { id: 'TXN-2', posted: 1754524800, amount: '2000.00', description: 'SALARY', pending: true },
      ],
      holdings: [],
    },
  ],
};

describe('parseAccountsResponse', () => {
  it('parses accounts and keeps money as strings', () => {
    const { accounts } = parseAccountsResponse(payload);
    expect(accounts).toHaveLength(1);
    expect(accounts[0].balance).toBe('1234.56');
    expect(typeof accounts[0].balance).toBe('string');
    expect(accounts[0].orgName).toBe('Test Bank');
    expect(accounts[0].balanceDate).toBe(1754524800);
  });

  it('preserves transaction sign and pending flag', () => {
    const [account] = parseAccountsResponse(payload).accounts;
    expect(account.transactions[0].amount).toBe('-42.10');
    expect(account.transactions[0].pending).toBe(false);
    expect(account.transactions[1].pending).toBe(true);
  });

  it('falls back to org domain when name is absent', () => {
    const { accounts } = parseAccountsResponse({
      accounts: [{ ...payload.accounts[0], org: { domain: 'testbank.com' } }],
    });
    expect(accounts[0].orgName).toBe('testbank.com');
  });

  it('prefers structured errlist over the deprecated flat errors array', () => {
    const { errors } = parseAccountsResponse({
      accounts: [],
      errors: ['legacy message'],
      errlist: [{ code: 'AUTH', msg: 'Reauthenticate Test Bank', conn_id: 'C1' }],
    });
    expect(errors).toHaveLength(1);
    expect(errors[0].code).toBe('AUTH');
    expect(errors[0].key).toBe('AUTH:C1');
  });

  it('wraps a legacy flat errors array when errlist is absent', () => {
    const { errors } = parseAccountsResponse({ accounts: [], errors: ['boom'] });
    expect(errors[0].code).toBe('legacy');
    expect(errors[0].msg).toBe('boom');
    expect(errors[0].key).toBe('legacy:boom');
  });

  it('throws on a payload that is not an object', () => {
    expect(() => parseAccountsResponse('nope')).toThrow(/payload/i);
  });
});
