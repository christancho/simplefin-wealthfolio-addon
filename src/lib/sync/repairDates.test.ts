import { describe, expect, it, vi } from 'vitest';
import { createMockHost } from '../../test/mockHost';
import { applyDateRepair, scanForMidnightUtcDates } from './repairDates';

const row = (over: Record<string, unknown> = {}) => ({
  id: 'ACT-1',
  accountId: 'WF-1',
  accountName: 'Checking',
  activityType: 'WITHDRAWAL',
  subtype: null,
  date: '2026-08-01T00:00:00.000Z',
  quantity: null,
  unitPrice: null,
  amount: '84.12',
  fee: '0',
  tax: null,
  currency: 'CAD',
  fxRate: null,
  comment: 'Costco',
  assetId: '$CASH-CAD',
  assetSymbol: '$CASH-CAD',
  metadata: undefined,
  needsReview: false,
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z',
  accountCurrency: 'CAD',
  ...over,
});

function hostWith(rows: unknown[]) {
  const host = createMockHost();
  let served = false;
  host.api.activities.search = vi.fn(async () => {
    if (served) return { data: [], meta: { totalRowCount: rows.length } };
    served = true;
    return { data: rows, meta: { totalRowCount: rows.length } };
  }) as never;
  return host;
}

describe('scanForMidnightUtcDates', () => {
  it('selects a row stored at exactly midnight UTC and targets noon UTC on the same date', async () => {
    const host = hostWith([row()]);

    const found = await scanForMidnightUtcDates(host.api, ['WF-1']);

    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      id: 'ACT-1',
      from: '2026-08-01T00:00:00.000Z',
      to: '2026-08-01T12:00:00.000Z',
    });
  });

  it('leaves a CSV-imported row at midnight local alone', async () => {
    // Wealthfolio's own CSV import stores midnight *local* (04:00Z in EDT),
    // which already displays on the right day — repairing it would be a
    // pointless rewrite of a row this addon never created.
    const host = hostWith([row({ date: '2026-07-10T04:00:00.000Z' })]);
    expect(await scanForMidnightUtcDates(host.api, ['WF-1'])).toEqual([]);
  });

  it('leaves an already-repaired noon-UTC row alone, so the repair is idempotent', async () => {
    const host = hostWith([row({ date: '2026-08-01T12:00:00.000Z' })]);
    expect(await scanForMidnightUtcDates(host.api, ['WF-1'])).toEqual([]);
  });

  it('leaves a genuine intraday timestamp alone', async () => {
    const host = hostWith([row({ date: '2026-08-01T14:32:11.000Z' })]);
    expect(await scanForMidnightUtcDates(host.api, ['WF-1'])).toEqual([]);
  });

  it('does not treat a row one millisecond past midnight UTC as ours', async () => {
    const host = hostWith([row({ date: '2026-08-01T00:00:00.001Z' })]);
    expect(await scanForMidnightUtcDates(host.api, ['WF-1'])).toEqual([]);
  });
});

describe('applyDateRepair', () => {
  it('carries every field through the update, changing only the date', async () => {
    // Field fidelity is the whole risk here: any field dropped from the
    // ActivityUpdate is a field the host nulls on a real financial record.
    const host = hostWith([row()]);
    const found = await scanForMidnightUtcDates(host.api, ['WF-1']);

    await applyDateRepair(host.api, found);

    const [request] = (host.api.activities.saveMany as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(request.updates).toHaveLength(1);
    expect(request.updates[0]).toEqual({
      id: 'ACT-1',
      accountId: 'WF-1',
      activityType: 'WITHDRAWAL',
      subtype: null,
      activityDate: '2026-08-01T12:00:00.000Z',
      asset: { id: '$CASH-CAD' },
      quantity: null,
      unitPrice: null,
      amount: '84.12',
      currency: 'CAD',
      fee: '0',
      tax: null,
      comment: 'Costco',
      fxRate: null,
    });
    expect(request.creates).toBeUndefined();
    expect(request.deleteIds).toBeUndefined();
  });

  it('preserves sourceGroupId so a reconciled transfer pair stays linked', async () => {
    // update() was confirmed against a live host to silently drop this,
    // which unlinks both legs and trips Wealthfolio's Data Consistency check.
    const host = hostWith([row({ activityType: 'TRANSFER_OUT', sourceGroupId: 'GRP-1' })]);
    const found = await scanForMidnightUtcDates(host.api, ['WF-1']);

    await applyDateRepair(host.api, found);

    const [request] = (host.api.activities.saveMany as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(request.updates[0].sourceGroupId).toBe('GRP-1');
  });

  it('omits sourceGroupId entirely for an ungrouped row rather than sending null', async () => {
    const host = hostWith([row()]);
    const found = await scanForMidnightUtcDates(host.api, ['WF-1']);

    await applyDateRepair(host.api, found);

    const [request] = (host.api.activities.saveMany as ReturnType<typeof vi.fn>).mock.calls[0];
    expect('sourceGroupId' in request.updates[0]).toBe(false);
  });

  it('omits asset entirely for a cash row with no assetId', async () => {
    // Every activity on the live instance is cash with assetId ''. Sending
    // `asset: { id: '' }` would ask the host to resolve a nonexistent asset.
    const host = hostWith([row({ assetId: '' })]);
    const found = await scanForMidnightUtcDates(host.api, ['WF-1']);

    await applyDateRepair(host.api, found);

    const [request] = (host.api.activities.saveMany as ReturnType<typeof vi.fn>).mock.calls[0];
    expect('asset' in request.updates[0]).toBe(false);
  });

  it('repairs only the requested number of rows when a limit is given', async () => {
    const host = hostWith([row(), row({ id: 'ACT-2' }), row({ id: 'ACT-3' })]);
    const found = await scanForMidnightUtcDates(host.api, ['WF-1']);

    const result = await applyDateRepair(host.api, found, { limit: 1 });

    expect(result.repaired).toBe(1);
    const [request] = (host.api.activities.saveMany as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(request.updates).toHaveLength(1);
  });

  it('reports per-item errors instead of counting a failed row as repaired', async () => {
    const host = hostWith([row()]);
    const found = await scanForMidnightUtcDates(host.api, ['WF-1']);
    host.api.activities.saveMany = vi.fn(async () => ({
      created: [],
      updated: [],
      deleted: [],
      createdMappings: [],
      errors: [{ id: 'ACT-1', action: 'update', message: 'rejected' }],
    })) as never;

    const result = await applyDateRepair(host.api, found);

    expect(result.repaired).toBe(0);
    expect(result.failed).toEqual([{ id: 'ACT-1', error: 'rejected' }]);
  });
});
