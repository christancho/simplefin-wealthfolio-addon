import type { ActivityDetails, ActivityUpdate } from '@wealthfolio/addon-sdk';

/**
 * The slice of the host this repair needs, rather than the full `HostAPI`.
 * `HostAPI` satisfies it structurally, and so does the REST adapter in
 * `scripts/repair-activity-dates.mjs` — the same tested logic drives both.
 */
export interface RepairHost {
  activities: {
    search(
      page: number,
      pageSize: number,
      filters: { accountIds?: string[] },
      searchKeyword: string,
    ): Promise<{ data: ActivityDetails[]; meta: { totalRowCount: number } }>;
    saveMany(request: {
      updates: ActivityUpdate[];
    }): Promise<{ errors: { id?: string; message: string }[] }>;
  };
  logger: { error(message: string): void; info(message: string): void };
}

/**
 * ONE-OFF REPAIR — delete this module, its test, and
 * `scripts/repair-activity-dates.mjs` once the production instance is fixed.
 *
 * Not referenced by any addon component, so it is not bundled into
 * `dist/addon.js` — it exists to be driven by that script.
 *
 * Activities pushed before `isoInstant()` existed went out as a bare
 * `YYYY-MM-DD`, which Wealthfolio's deserializer expanded to midnight UTC.
 * Their stored *calendar date* is correct; only the time-of-day is wrong, and
 * localizing midnight UTC in a UTC-negative zone rolls the display back a day.
 * So the repair is a pure time-of-day shift on the same UTC date — no
 * re-fetching from the Bridge, no re-deriving anything.
 *
 * Rows are selected by an exact `00:00:00.000Z` stamp, which is what this
 * addon produced and nothing else does: Wealthfolio's own CSV import stores
 * midnight *local* (04:00Z in EDT), and rows pushed after the fix are at noon
 * UTC. That makes the repair idempotent — a second run finds nothing.
 */

/** The timezone-safe midpoint: noon UTC holds its calendar date from UTC-11 to UTC+11. */
const REPAIRED_HOUR_UTC = 12;

/** `activities.search()`'s page size, matching `reconciliation.ts`. */
const SEARCH_PAGE_SIZE = 200;

export interface DateRepair {
  row: ActivityDetails;
  id: string;
  accountName: string;
  comment: string;
  amount: string;
  from: string;
  to: string;
}

export interface DateRepairResult {
  repaired: number;
  failed: { id: string; error: string }[];
}

/** True only for an exact midnight-UTC stamp — one millisecond past it is somebody else's row. */
function isMidnightUtc(date: Date): boolean {
  return (
    date.getUTCHours() === 0 &&
    date.getUTCMinutes() === 0 &&
    date.getUTCSeconds() === 0 &&
    date.getUTCMilliseconds() === 0
  );
}

/** Same UTC calendar date, moved to noon UTC. */
function repairedInstant(date: Date): string {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), REPAIRED_HOUR_UTC),
  ).toISOString();
}

/**
 * `sourceGroupId` is on the host's `Activity` model but missing from the SDK's
 * `ActivityDetails` type — present in the runtime JSON regardless, same as in
 * `reconciliation.ts`.
 */
function sourceGroupIdOf(row: ActivityDetails): string | null {
  return ((row as unknown as Record<string, unknown>).sourceGroupId as string | null | undefined) ?? null;
}

/** Reads every activity in the given accounts, unfiltered by type. */
async function searchAll(api: RepairHost, accountIds: string[]): Promise<ActivityDetails[]> {
  const results: ActivityDetails[] = [];
  let page = 0;
  for (;;) {
    const response = await api.activities.search(page, SEARCH_PAGE_SIZE, { accountIds }, '');
    results.push(...response.data);
    if (response.data.length === 0 || results.length >= response.meta.totalRowCount) break;
    page += 1;
  }
  return results;
}

/** Read-only: reports what `applyDateRepair` would change, without changing anything. */
export async function scanForMidnightUtcDates(
  api: RepairHost,
  accountIds: string[],
): Promise<DateRepair[]> {
  const rows = await searchAll(api, accountIds);

  return rows.flatMap((row) => {
    const date = new Date(row.date);
    if (!isMidnightUtc(date)) return [];
    return [
      {
        row,
        id: row.id,
        accountName: row.accountName,
        comment: row.comment ?? '',
        amount: row.amount ?? '0',
        from: date.toISOString(),
        to: repairedInstant(date),
      },
    ];
  });
}

/**
 * Every field `ActivityDetails` carries that `ActivityUpdate` accepts is passed
 * back explicitly. An omitted field is a field the host nulls on a real
 * financial record, so this must stay exhaustive — only `activityDate` changes.
 */
function toUpdate(repair: DateRepair): ActivityUpdate {
  const { row } = repair;
  const sourceGroupId = sourceGroupIdOf(row);

  return {
    id: row.id,
    accountId: row.accountId,
    activityType: row.activityType,
    subtype: row.subtype,
    activityDate: repair.to,
    // Sent explicitly so a reconciled transfer pair stays linked: `update()`
    // was confirmed against a live host to drop this silently, which leaves
    // both legs correctly typed but unlinked — invisible to the update call
    // and visible to Wealthfolio's Data Consistency checker.
    ...(sourceGroupId !== null ? { sourceGroupId } : {}),
    // Cash activities carry an empty `assetId` (confirmed against the live
    // instance: all 168 rows). Sending `asset: { id: '' }` would ask the host
    // to resolve an asset that doesn't exist, so the key is omitted instead.
    ...(row.assetId ? { asset: { id: row.assetId } } : {}),
    quantity: row.quantity,
    unitPrice: row.unitPrice,
    amount: row.amount,
    currency: row.currency,
    fee: row.fee,
    tax: row.tax,
    comment: row.comment,
    fxRate: row.fxRate,
    ...(row.metadata !== undefined ? { metadata: row.metadata } : {}),
  };
}

/**
 * Applies the repair in one `saveMany` batch per `batchSize` rows. `limit`
 * exists so the first run can repair a single row and have it eyeballed in
 * Wealthfolio — date corrected, amount/comment/asset intact, transfer pair
 * still linked — before the rest are touched.
 */
export async function applyDateRepair(
  api: RepairHost,
  repairs: DateRepair[],
  options: { limit?: number; batchSize?: number } = {},
): Promise<DateRepairResult> {
  const { limit, batchSize = 100 } = options;
  const selected = limit === undefined ? repairs : repairs.slice(0, limit);

  let repaired = 0;
  const failed: { id: string; error: string }[] = [];

  for (let i = 0; i < selected.length; i += batchSize) {
    const batch = selected.slice(i, i + batchSize);
    const result = await api.activities.saveMany({ updates: batch.map(toUpdate) });

    for (const error of result.errors) {
      failed.push({ id: error.id ?? '(unknown)', error: error.message });
    }
    repaired += batch.length - result.errors.length;

    if (result.errors.length > 0) {
      api.logger.error(
        `[simplefin] date repair: ${result.errors.length} of ${batch.length} row(s) rejected: ` +
          JSON.stringify(result.errors),
      );
    }
  }

  api.logger.info(`[simplefin] date repair: ${repaired} repaired, ${failed.length} failed`);
  return { repaired, failed };
}
