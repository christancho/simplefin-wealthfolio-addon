import { describe, expect, it } from 'vitest';
import { createMockHost } from '../../test/mockHost';
import { AUTH_SECRET_KEY, fetchAccounts } from './client';

const BASE = 'https://bridge.simplefin.org/simplefin';

describe('fetchAccounts', () => {
  it('sends a brokered basic-auth request referencing the secret by key', async () => {
    const host = createMockHost();
    host.respond(/\/accounts/, { body: JSON.stringify({ accounts: [], errors: [] }) });

    await fetchAccounts(host.api.network, BASE, {});

    const [req] = host.requests;
    expect(req.method).toBe('GET');
    expect(req.auth).toEqual({ type: 'basic', secretKey: AUTH_SECRET_KEY });
    // The credential must never appear in the URL — the host injects it.
    expect(req.url).not.toContain('@');
  });

  it('builds the documented query parameters', async () => {
    const host = createMockHost();
    host.respond(/\/accounts/, { body: JSON.stringify({ accounts: [], errors: [] }) });

    await fetchAccounts(host.api.network, BASE, {
      startDate: 1754438400,
      endDate: 1754524800,
      pending: true,
      accountIds: ['A-1', 'A-2'],
    });

    const url = new URL(host.requests[0].url);
    expect(url.pathname).toBe('/simplefin/accounts');
    expect(url.searchParams.get('start-date')).toBe('1754438400');
    expect(url.searchParams.get('end-date')).toBe('1754524800');
    expect(url.searchParams.get('pending')).toBe('1');
    expect(url.searchParams.getAll('account')).toEqual(['A-1', 'A-2']);
  });

  it('omits optional parameters that were not supplied', async () => {
    const host = createMockHost();
    host.respond(/\/accounts/, { body: JSON.stringify({ accounts: [], errors: [] }) });

    await fetchAccounts(host.api.network, BASE, {});

    const url = new URL(host.requests[0].url);
    expect(url.searchParams.has('start-date')).toBe(false);
    expect(url.searchParams.has('pending')).toBe(false);
  });

  it('returns bridge errors without throwing so other accounts still sync', async () => {
    const host = createMockHost();
    host.respond(/\/accounts/, {
      body: JSON.stringify({
        accounts: [],
        errlist: [{ code: 'AUTH', msg: 'Reauthenticate Test Bank', conn_id: 'C1' }],
      }),
    });

    const result = await fetchAccounts(host.api.network, BASE, {});
    expect(result.errors).toHaveLength(1);
    expect(result.accounts).toEqual([]);
  });

  it('throws on a non-200 status', async () => {
    const host = createMockHost();
    host.respond(/\/accounts/, { status: 403, body: 'Forbidden' });

    await expect(fetchAccounts(host.api.network, BASE, {})).rejects.toThrow(/403/);
  });

  it('throws a clear error when the body is not JSON', async () => {
    const host = createMockHost();
    host.respond(/\/accounts/, { body: '<html>gateway error</html>' });

    await expect(fetchAccounts(host.api.network, BASE, {})).rejects.toThrow(/JSON/i);
  });
});
