import { describe, expect, it, vi } from 'vitest';
import type { ActivityImport } from '@wealthfolio/addon-sdk';
import { createMockHost } from '../../test/mockHost';
import type { AccountMapping } from '../storage/config';
import { emptyWatermark } from '../storage/watermark';
import { detectCandidate, isPaymentCandidate, syncCashAccount, toActivityImport } from './activities';

const mapping: AccountMapping = {
  sfAccountId: 'ACT-1',
  wfAccountId: 'WF-1',
  mode: 'CASH',
  sfAccountName: 'Checking',
  orgName: 'Test Bank',
};

const txn = (over: Partial<Record<string, unknown>> = {}) => ({
  id: 'TXN-1',
  posted: 1754438400,
  amount: '-42.10',
  description: 'COFFEE',
  payee: 'Blue Bottle',
  memo: null,
  pending: false,
  ...over,
});

describe('toActivityImport', () => {
  it('maps a negative amount to a WITHDRAWAL with positive magnitude', () => {
    const activity = toActivityImport(txn() as never, mapping, 'USD', 'CASH');
    expect(activity.activityType).toBe('WITHDRAWAL');
    expect(activity.amount).toBe('42.10');
    expect(activity.accountId).toBe('WF-1');
    expect(activity.currency).toBe('USD');
  });

  it('maps a positive amount to a DEPOSIT on a non-credit-card account', () => {
    const activity = toActivityImport(txn({ amount: '2000.00' }) as never, mapping, 'USD', 'CASH');
    expect(activity.activityType).toBe('DEPOSIT');
    expect(activity.amount).toBe('2000.00');
  });

  it('maps a positive amount to CREDIT on a credit-card account, since the host rejects DEPOSIT there', () => {
    // Regression test: confirmed against a live host — DEPOSIT on a
    // CREDIT_CARD account is rejected with "DEPOSIT activities are not
    // supported for credit card accounts"; CREDIT is accepted.
    const activity = toActivityImport(txn({ amount: '50.00' }) as never, mapping, 'USD', 'CREDIT_CARD');
    expect(activity.activityType).toBe('CREDIT');
  });

  it('still maps a negative amount to WITHDRAWAL on a credit-card account (a purchase)', () => {
    const activity = toActivityImport(txn() as never, mapping, 'USD', 'CREDIT_CARD');
    expect(activity.activityType).toBe('WITHDRAWAL');
  });

  it('keeps the amount as a string to avoid float rounding', () => {
    const activity = toActivityImport(txn({ amount: '-0.1' }) as never, mapping, 'USD', 'CASH');
    expect(typeof activity.amount).toBe('string');
    expect(activity.amount).toBe('0.1');
  });

  it('prefers payee over description for the comment, falling back to description', () => {
    expect(toActivityImport(txn() as never, mapping, 'USD', 'CASH').comment).toBe('Blue Bottle');
    expect(toActivityImport(txn({ payee: null }) as never, mapping, 'USD', 'CASH').comment).toBe('COFFEE');
  });

  it('converts the epoch posted date to an ISO date', () => {
    const activity = toActivityImport(txn() as never, mapping, 'USD', 'CASH');
    expect(activity.date).toBe('2025-08-06');
  });

  it('sets symbol to an empty string, since the host rejects the whole batch if it is absent', () => {
    const activity = toActivityImport(txn() as never, mapping, 'USD', 'CASH');
    expect(activity.symbol).toBe('');
  });
});

describe('isPaymentCandidate', () => {
  it('matches case-insensitively against any configured keyword', () => {
    expect(isPaymentCandidate('ONLINE PAYMENT - THANK YOU', ['payment'])).toBe(true);
    expect(isPaymentCandidate('autopay from checking', ['AUTOPAY'])).toBe(true);
  });

  it('does not match an unrelated merchant credit', () => {
    expect(isPaymentCandidate('Amazon Refund', ['PAYMENT', 'AUTOPAY', 'THANK YOU'])).toBe(false);
  });

  it('ignores blank keywords rather than matching everything', () => {
    expect(isPaymentCandidate('Amazon Refund', ['', '  '])).toBe(false);
  });
});

describe('detectCandidate', () => {
  it('stages a keyword-matched card CREDIT with inflowActivityId unresolved', () => {
    const candidate = detectCandidate(
      txn({ id: 'TXN-9', amount: '75.00', payee: 'Online Payment Thank You', posted: 1754438400 }) as never,
      mapping,
      ['PAYMENT'],
      'CREDIT',
      'USD',
    );
    expect(candidate).toEqual({
      sfTransactionId: 'TXN-9',
      inflowAccountId: 'WF-1',
      inflowActivityId: null,
      inflowActivityType: 'CREDIT',
      amount: '75.00',
      currency: 'USD',
      postedDate: '2025-08-06',
      comment: 'Online Payment Thank You',
      status: 'pending',
      candidateWithdrawalIds: [],
    });
  });

  it('stages a keyword-matched cash DEPOSIT as inflowActivityType DEPOSIT', () => {
    const candidate = detectCandidate(
      txn({ id: 'TXN-10', amount: '200.00', payee: 'Online Transfer From Checking', posted: 1754438400 }) as never,
      mapping,
      ['TRANSFER'],
      'DEPOSIT',
      'USD',
    );
    expect(candidate).toEqual({
      sfTransactionId: 'TXN-10',
      inflowAccountId: 'WF-1',
      inflowActivityId: null,
      inflowActivityType: 'DEPOSIT',
      amount: '200.00',
      currency: 'USD',
      postedDate: '2025-08-06',
      comment: 'Online Transfer From Checking',
      status: 'pending',
      candidateWithdrawalIds: [],
    });
  });

  it('returns null for a transaction that does not match any keyword', () => {
    expect(detectCandidate(txn({ payee: 'Amazon Refund' }) as never, mapping, ['PAYMENT'], 'CREDIT', 'USD')).toBeNull();
  });
});

describe('syncCashAccount', () => {
  const account = (transactions: unknown[]) => ({
    id: 'ACT-1',
    name: 'Checking',
    currency: 'USD',
    balance: '100.00',
    balanceDate: 1754524800,
    orgName: 'Test Bank',
    transactions,
    holdings: [],
  });

  it('skips pending transactions', async () => {
    const host = createMockHost();
    host.api.activities.checkImport = vi.fn(async (a) => a);
    host.api.activities.import = vi.fn(async () => ({
      activities: [],
      importRunId: 'R1',
      summary: { total: 0, imported: 0, skipped: 0, duplicates: 0, assetsCreated: 0, success: true },
    }));

    await syncCashAccount(
      host.api,
      mapping,
      account([txn({ pending: true })]) as never,
      emptyWatermark(),
      'CASH',
      [],
      [],
    );

    expect(host.api.activities.import).not.toHaveBeenCalled();
  });

  it('skips transactions already in the recent-id window', async () => {
    const host = createMockHost();
    host.api.activities.checkImport = vi.fn(async (a) => a);

    await syncCashAccount(
      host.api,
      mapping,
      account([txn()]) as never,
      { lastPosted: 1754438400, recentIds: ['TXN-1'] },
      'CASH',
      [],
      [],
    );

    expect(host.api.activities.import).not.toHaveBeenCalled();
  });

  it('validates via checkImport before importing', async () => {
    const host = createMockHost();
    const order: string[] = [];
    host.api.activities.checkImport = vi.fn(async (a) => {
      order.push('check');
      return a;
    });
    host.api.activities.import = vi.fn(async () => {
      order.push('import');
      return {
        activities: [],
        importRunId: 'R1',
        summary: { total: 1, imported: 1, skipped: 0, duplicates: 0, assetsCreated: 0, success: true },
      };
    });

    await syncCashAccount(host.api, mapping, account([txn()]) as never, emptyWatermark(), 'CASH', [], []);
    expect(order).toEqual(['check', 'import']);
  });

  it('does not import rows the host flagged as duplicates', async () => {
    const host = createMockHost();
    host.api.activities.checkImport = vi.fn(async (a: ActivityImport[]) =>
      a.map((row) => ({ ...row, duplicateOfId: 'EXISTING', isValid: true })),
    );
    host.api.activities.import = vi.fn();

    const { result } = await syncCashAccount(host.api, mapping, account([txn()]) as never, emptyWatermark(), 'CASH', [], []);

    expect(host.api.activities.import).not.toHaveBeenCalled();
    expect(result.duplicates).toBe(1);
  });

  it('does not import rows checkImport marked invalid', async () => {
    const host = createMockHost();
    host.api.activities.checkImport = vi.fn(async (a: ActivityImport[]) =>
      a.map((row) => ({ ...row, isValid: false, errors: { amount: ['bad'] } })),
    );
    host.api.activities.import = vi.fn();

    const { result } = await syncCashAccount(host.api, mapping, account([txn()]) as never, emptyWatermark(), 'CASH', [], []);

    expect(host.api.activities.import).not.toHaveBeenCalled();
    expect(result.skipped).toBe(1);
  });

  it('advances the watermark only over transactions actually imported', async () => {
    const host = createMockHost();
    host.api.activities.checkImport = vi.fn(async (a) => a);
    host.api.activities.import = vi.fn(async () => ({
      activities: [],
      importRunId: 'R1',
      summary: { total: 1, imported: 1, skipped: 0, duplicates: 0, assetsCreated: 0, success: true },
    }));

    const { watermark } = await syncCashAccount(host.api, mapping, account([txn()]) as never, emptyWatermark(), 'CASH', [], []);

    expect(watermark.lastPosted).toBe(1754438400);
    expect(watermark.recentIds).toContain('TXN-1');
  });

  it('leaves the watermark untouched when the import throws', async () => {
    const host = createMockHost();
    host.api.activities.checkImport = vi.fn(async (a) => a);
    host.api.activities.import = vi.fn(async () => {
      throw new Error('host exploded');
    });

    await expect(
      syncCashAccount(host.api, mapping, account([txn()]) as never, emptyWatermark(), 'CASH', [], []),
    ).rejects.toThrow(/host exploded/);
  });

  it('logs the rejected payload when checkImport itself throws, so the failing row is visible', async () => {
    const host = createMockHost();
    host.api.activities.checkImport = vi.fn(async () => {
      throw new Error('Unprocessable Entity');
    });

    await expect(
      syncCashAccount(host.api, mapping, account([txn()]) as never, emptyWatermark(), 'CASH', [], []),
    ).rejects.toThrow(/Unprocessable Entity/);

    expect(host.api.logger.error).toHaveBeenCalledWith(expect.stringContaining(mapping.sfAccountName));
    expect(host.api.logger.error).toHaveBeenCalledWith(expect.stringContaining('"symbol":""'));
  });

  it('logs the rejected payload when the host import throws, so the failing row is visible', async () => {
    const host = createMockHost();
    host.api.activities.checkImport = vi.fn(async (a) => a);
    host.api.activities.import = vi.fn(async () => {
      throw new Error('Unprocessable Entity');
    });

    await expect(
      syncCashAccount(host.api, mapping, account([txn()]) as never, emptyWatermark(), 'CASH', [], []),
    ).rejects.toThrow(/Unprocessable Entity/);

    expect(host.api.logger.error).toHaveBeenCalledWith(expect.stringContaining(mapping.sfAccountName));
    expect(host.api.logger.error).toHaveBeenCalledWith(expect.stringContaining('"amount":"42.10"'));
  });

  it('imports an inflow transaction on a credit-card account as CREDIT, not DEPOSIT', async () => {
    const host = createMockHost();
    host.api.activities.checkImport = vi.fn(async (a: ActivityImport[]) => a.map((row) => ({ ...row, isValid: true })));
    let importedRows: ActivityImport[] = [];
    host.api.activities.import = vi.fn(async (rows: ActivityImport[]) => {
      importedRows = rows;
      return {
        activities: [],
        importRunId: 'R1',
        summary: { total: 1, imported: 1, skipped: 0, duplicates: 0, assetsCreated: 0, success: true },
      };
    });

    await syncCashAccount(
      host.api,
      mapping,
      account([txn({ amount: '50.00', payee: 'Card Payment' })]) as never,
      emptyWatermark(),
      'CREDIT_CARD',
      [],
      [],
    );

    expect(importedRows[0].activityType).toBe('CREDIT');
  });

  it('stages a keyword-matched inflow on a credit-card account as a CREDIT candidate', async () => {
    const host = createMockHost();
    host.api.activities.checkImport = vi.fn(async (a: ActivityImport[]) => a.map((row) => ({ ...row, isValid: true })));
    host.api.activities.import = vi.fn(async () => ({
      activities: [],
      importRunId: 'R1',
      summary: { total: 1, imported: 1, skipped: 0, duplicates: 0, assetsCreated: 0, success: true },
    }));

    const { candidates } = await syncCashAccount(
      host.api,
      mapping,
      account([txn({ amount: '75.00', payee: 'Online Payment Thank You' })]) as never,
      emptyWatermark(),
      'CREDIT_CARD',
      ['PAYMENT'],
      [],
    );

    expect(candidates).toHaveLength(1);
    expect(candidates[0].sfTransactionId).toBe('TXN-1');
    expect(candidates[0].inflowActivityType).toBe('CREDIT');
  });

  it('does not stage a non-matching inflow, an outflow, or a card inflow against transferKeywords', async () => {
    const host = createMockHost();
    host.api.activities.checkImport = vi.fn(async (a: ActivityImport[]) => a.map((row) => ({ ...row, isValid: true })));
    host.api.activities.import = vi.fn(async () => ({
      activities: [],
      importRunId: 'R1',
      summary: { total: 1, imported: 1, skipped: 0, duplicates: 0, assetsCreated: 0, success: true },
    }));

    const nonMatching = await syncCashAccount(
      host.api,
      mapping,
      account([txn({ amount: '75.00', payee: 'Amazon Refund' })]) as never,
      emptyWatermark(),
      'CREDIT_CARD',
      ['PAYMENT'],
      [],
    );
    expect(nonMatching.candidates).toEqual([]);

    const outflow = await syncCashAccount(
      host.api,
      mapping,
      account([txn({ amount: '-75.00', payee: 'Payment Center' })]) as never,
      emptyWatermark(),
      'CREDIT_CARD',
      ['PAYMENT'],
      [],
    );
    expect(outflow.candidates).toEqual([]);

    // A card account's inflow is checked only against paymentKeywords, never transferKeywords.
    const cardAgainstTransferKeywords = await syncCashAccount(
      host.api,
      mapping,
      account([txn({ amount: '75.00', payee: 'Online Transfer From Checking' })]) as never,
      emptyWatermark(),
      'CREDIT_CARD',
      ['PAYMENT'],
      ['TRANSFER'],
    );
    expect(cardAgainstTransferKeywords.candidates).toEqual([]);
  });

  it('stages a keyword-matched inflow on a non-card cash account as a DEPOSIT transfer candidate', async () => {
    const host = createMockHost();
    host.api.activities.checkImport = vi.fn(async (a: ActivityImport[]) => a.map((row) => ({ ...row, isValid: true })));
    host.api.activities.import = vi.fn(async () => ({
      activities: [],
      importRunId: 'R1',
      summary: { total: 1, imported: 1, skipped: 0, duplicates: 0, assetsCreated: 0, success: true },
    }));

    const { candidates } = await syncCashAccount(
      host.api,
      mapping,
      account([txn({ amount: '200.00', payee: 'Online Transfer From Checking' })]) as never,
      emptyWatermark(),
      'CASH',
      [],
      ['TRANSFER'],
    );

    expect(candidates).toHaveLength(1);
    expect(candidates[0].sfTransactionId).toBe('TXN-1');
    expect(candidates[0].inflowActivityType).toBe('DEPOSIT');
  });

  it('does not stage a non-matching inflow, an outflow, or a cash inflow against paymentKeywords', async () => {
    const host = createMockHost();
    host.api.activities.checkImport = vi.fn(async (a: ActivityImport[]) => a.map((row) => ({ ...row, isValid: true })));
    host.api.activities.import = vi.fn(async () => ({
      activities: [],
      importRunId: 'R1',
      summary: { total: 1, imported: 1, skipped: 0, duplicates: 0, assetsCreated: 0, success: true },
    }));

    const nonMatching = await syncCashAccount(
      host.api,
      mapping,
      account([txn({ amount: '200.00', payee: 'Employer Payroll' })]) as never,
      emptyWatermark(),
      'CASH',
      [],
      ['TRANSFER'],
    );
    expect(nonMatching.candidates).toEqual([]);

    const outflow = await syncCashAccount(
      host.api,
      mapping,
      account([txn({ amount: '-200.00', payee: 'Online Transfer To Savings' })]) as never,
      emptyWatermark(),
      'CASH',
      [],
      ['TRANSFER'],
    );
    expect(outflow.candidates).toEqual([]);

    // A cash account's inflow is checked only against transferKeywords, never paymentKeywords.
    const cashAgainstPaymentKeywords = await syncCashAccount(
      host.api,
      mapping,
      account([txn({ amount: '200.00', payee: 'Online Payment Thank You' })]) as never,
      emptyWatermark(),
      'CASH',
      ['PAYMENT'],
      ['TRANSFER'],
    );
    expect(cashAgainstPaymentKeywords.candidates).toEqual([]);
  });
});
