import type { ActivityDetails, ActivityUpdate, HostAPI } from '@wealthfolio/addon-sdk';
import type { StagedCandidate } from '../storage/staging';
import { normalise } from './balance';

/**
 * Unresolved candidate older than this, from its card payment's posted date,
 * drops out of staging without creating a transfer — required by issue #50
 * so the staged list can't grow unbounded when a pair genuinely never
 * appears (e.g. paid from an untracked account).
 */
export const EXPIRY_DAYS = 7;

/**
 * The cash debit for a card payment typically lands up to this many days
 * before the card's payment posts — required by issue #50's matching window.
 */
export const MATCH_WINDOW_DAYS = 3;

const SECONDS_PER_DAY = 86_400;

/** activities.search()'s page size — large enough that most accounts resolve in one page. */
const SEARCH_PAGE_SIZE = 200;

/**
 * `ActivityDetails.date` is typed as `Date` but the host serialises it as an
 * ISO datetime string over JSON (confirmed against a live host) — this
 * normalises either shape down to a comparable YYYY-MM-DD.
 */
function toIsoDateOnly(dateLike: unknown): string {
  return new Date(dateLike as string | Date).toISOString().slice(0, 10);
}

/**
 * `activities.search()` paginates from page 0 (confirmed against a live
 * host — passing 1 as the first page silently returns an empty `data` with a
 * nonzero `totalRowCount`). Its `searchKeyword` doesn't match `comment`
 * either, so filtering happens entirely client-side over the type/account
 * scoped result set this fetches.
 */
async function searchAllByType(
  api: HostAPI,
  accountIds: string[],
  activityTypes: string,
): Promise<ActivityDetails[]> {
  const results: ActivityDetails[] = [];
  let page = 0;
  for (;;) {
    const response = await api.activities.search(page, SEARCH_PAGE_SIZE, { accountIds, activityTypes }, '');
    results.push(...response.data);
    if (response.data.length === 0 || results.length >= response.meta.totalRowCount) break;
    page += 1;
  }
  return results;
}

/**
 * Resolves a staged candidate's real card-side activity. Once
 * `cardActivityId` is known, looks it up directly; otherwise matches by
 * account/amount/date/comment (the only info staged at detection time,
 * since `import()`'s response never carries the real persisted id).
 */
export async function findCardActivity(api: HostAPI, candidate: StagedCandidate): Promise<ActivityDetails | null> {
  const rows = await searchAllByType(api, [candidate.cardAccountId], 'CREDIT');
  if (candidate.cardActivityId) {
    return rows.find((r) => r.id === candidate.cardActivityId) ?? null;
  }
  return (
    rows.find(
      (r) =>
        normalise(r.amount ?? '0') === normalise(candidate.amount) &&
        toIsoDateOnly(r.date) === candidate.postedDate &&
        r.comment === candidate.comment,
    ) ?? null
  );
}

async function findWithdrawalMatches(
  api: HostAPI,
  cashAccountIds: string[],
  candidate: StagedCandidate,
): Promise<ActivityDetails[]> {
  if (cashAccountIds.length === 0) return [];

  const cardPostedSeconds = Date.parse(candidate.postedDate) / 1000;
  const windowStartSeconds = cardPostedSeconds - MATCH_WINDOW_DAYS * SECONDS_PER_DAY;

  const withdrawals = await searchAllByType(api, cashAccountIds, 'WITHDRAWAL');
  return withdrawals.filter((w) => {
    const postedSeconds = Date.parse(toIsoDateOnly(w.date)) / 1000;
    return (
      normalise(w.amount ?? '0') === normalise(candidate.amount) &&
      postedSeconds >= windowStartSeconds &&
      postedSeconds <= cardPostedSeconds
    );
  });
}

/** Returns full details for a specific set of already-known withdrawal ids, for UI display. */
export async function describeWithdrawals(
  api: HostAPI,
  cashAccountIds: string[],
  ids: string[],
): Promise<ActivityDetails[]> {
  const withdrawals = await searchAllByType(api, cashAccountIds, 'WITHDRAWAL');
  return withdrawals.filter((w) => ids.includes(w.id));
}

function toUpdate(row: ActivityDetails, activityType: string): ActivityUpdate {
  return {
    id: row.id,
    accountId: row.accountId,
    activityType,
    activityDate: row.date,
    amount: row.amount,
    currency: row.currency,
    comment: row.comment,
  };
}

/**
 * `sourceGroupId` is deliberately not set here — confirmed against a live
 * host that `activities.update()` doesn't persist it, so there is no
 * host-side visual pairing available; the two legs are linked only by the
 * staging record until it's dropped.
 */
async function reclassifyPair(api: HostAPI, cardRow: ActivityDetails, withdrawalRow: ActivityDetails): Promise<void> {
  await api.activities.update(toUpdate(cardRow, 'TRANSFER_IN'));
  await api.activities.update(toUpdate(withdrawalRow, 'TRANSFER_OUT'));
}

export interface ReconciliationSummary {
  resolved: number;
  expired: number;
}

/**
 * Runs once per sync. For each staged candidate: expire if past the window,
 * otherwise resolve its real card activity and search for matching
 * withdrawals — 0 stays pending, 1 auto-resolves, 2+ becomes ambiguous for
 * manual resolution. One candidate's failure never blocks another's.
 */
export async function runReconciliation(
  api: HostAPI,
  candidates: StagedCandidate[],
  cashAccountIds: string[],
  nowSeconds: number,
): Promise<{ candidates: StagedCandidate[]; summary: ReconciliationSummary }> {
  const remaining: StagedCandidate[] = [];
  let resolved = 0;
  let expired = 0;

  for (const candidate of candidates) {
    const postedSeconds = Date.parse(candidate.postedDate) / 1000;
    if (nowSeconds - postedSeconds > EXPIRY_DAYS * SECONDS_PER_DAY) {
      expired += 1;
      continue;
    }

    try {
      const cardRow = await findCardActivity(api, candidate);
      if (!cardRow) {
        // Host indexing lag or a transaction detected but not yet settled —
        // retry on the next sync run.
        remaining.push(candidate);
        continue;
      }

      const withdrawals = await findWithdrawalMatches(api, cashAccountIds, candidate);

      if (withdrawals.length === 0) {
        remaining.push({ ...candidate, cardActivityId: cardRow.id, status: 'pending', candidateWithdrawalIds: [] });
        continue;
      }
      if (withdrawals.length > 1) {
        remaining.push({
          ...candidate,
          cardActivityId: cardRow.id,
          status: 'ambiguous',
          candidateWithdrawalIds: withdrawals.map((w) => w.id),
        });
        continue;
      }

      await reclassifyPair(api, cardRow, withdrawals[0]);
      resolved += 1;
    } catch (error) {
      api.logger.error(
        `[simplefin] reconciliation failed for staged candidate ${candidate.sfTransactionId}: ${String(error)}`,
      );
      remaining.push(candidate);
    }
  }

  return { candidates: remaining, summary: { resolved, expired } };
}

/** Manual resolution from the Staged Transactions UI for an `ambiguous` candidate. */
export async function resolveAmbiguous(
  api: HostAPI,
  candidate: StagedCandidate,
  cashAccountIds: string[],
  chosenWithdrawalId: string,
): Promise<void> {
  const cardRow = await findCardActivity(api, candidate);
  if (!cardRow) {
    throw new Error(`Could not find the card activity for candidate ${candidate.sfTransactionId}`);
  }

  const withdrawals = await searchAllByType(api, cashAccountIds, 'WITHDRAWAL');
  const withdrawalRow = withdrawals.find((w) => w.id === chosenWithdrawalId);
  if (!withdrawalRow) {
    throw new Error(`Could not find withdrawal ${chosenWithdrawalId}`);
  }

  await reclassifyPair(api, cardRow, withdrawalRow);
}
