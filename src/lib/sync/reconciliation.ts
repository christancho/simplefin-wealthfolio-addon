import type { ActivityDetails, ActivityUpdate, HostAPI } from '@wealthfolio/addon-sdk';
import type { StagedCandidate } from '../storage/staging';
import { isPaymentCandidate } from './activities';
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

/**
 * Filters an already-fetched withdrawal pool down to this candidate's
 * matches (same amount, posted within the match window). Pure and
 * synchronous on purpose — the withdrawal pool is identical for every
 * candidate in a run, so callers fetch it once via `searchAllByType` and
 * reuse it across candidates rather than re-fetching per candidate.
 */
function withdrawalMatches(withdrawals: ActivityDetails[], candidate: StagedCandidate): ActivityDetails[] {
  const cardPostedSeconds = Date.parse(candidate.postedDate) / 1000;
  const windowStartSeconds = cardPostedSeconds - MATCH_WINDOW_DAYS * SECONDS_PER_DAY;

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

/** True if `row` is already represented in `existing`, resolved or not — never stage it twice. */
function isAlreadyStaged(row: ActivityDetails, existing: StagedCandidate[]): boolean {
  return existing.some((c) =>
    c.cardActivityId
      ? c.cardActivityId === row.id
      : c.cardAccountId === row.accountId &&
        normalise(c.amount) === normalise(row.amount ?? '0') &&
        c.postedDate === toIsoDateOnly(row.date) &&
        c.comment === (row.comment ?? ''),
  );
}

/**
 * Scans already-imported `CREDIT` activities on the given card accounts for
 * ones that look like bill payments but were never staged — either because
 * they predate this feature, or because the sync that imported them ran
 * before detection existed. Unlike live detection, the Wealthfolio activity
 * already exists, so `cardActivityId` is known immediately; no fuzzy lookup
 * is needed later. See `StagedCandidate.backfilled` for why these are exempt
 * from the normal expiry sweep.
 */
export async function findBackfillCandidates(
  api: HostAPI,
  cardAccountIds: string[],
  paymentKeywords: string[],
  existingStaging: StagedCandidate[],
): Promise<StagedCandidate[]> {
  if (cardAccountIds.length === 0) return [];

  const rows = await searchAllByType(api, cardAccountIds, 'CREDIT');

  return rows
    .filter((row) => isPaymentCandidate(row.comment ?? '', paymentKeywords))
    .filter((row) => !isAlreadyStaged(row, existingStaging))
    .map((row) => ({
      sfTransactionId: row.id,
      cardAccountId: row.accountId,
      cardActivityId: row.id,
      amount: row.amount ?? '0',
      postedDate: toIsoDateOnly(row.date),
      comment: row.comment ?? '',
      status: 'pending' as const,
      candidateWithdrawalIds: [],
      backfilled: true,
    }));
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
 *
 * Both legs are sent in a single `saveMany()` call rather than two
 * sequential `update()` calls: `findCardActivity()` only ever searches
 * `activityTypes: 'CREDIT'`, so if the card leg alone were reclassified to
 * `TRANSFER_IN` and the withdrawal leg's write then failed, the next
 * reconciliation attempt could never re-find the (now non-CREDIT) card
 * activity — leaving the pair permanently half-reclassified. One request,
 * one failure path avoids that split-write state.
 *
 * `saveMany` can also resolve successfully while still reporting a per-item
 * failure in `result.errors` rather than throwing — that's checked here and
 * turned into a thrown error so the caller's existing catch/retry path (in
 * `runReconciliation`) treats it the same as a hard failure, instead of
 * counting the candidate resolved while one or both legs never actually
 * changed.
 */
async function reclassifyPair(
  api: HostAPI,
  cardRow: ActivityDetails,
  withdrawalRow: ActivityDetails,
  sfTransactionId: string,
): Promise<void> {
  const result = await api.activities.saveMany({
    updates: [toUpdate(cardRow, 'TRANSFER_IN'), toUpdate(withdrawalRow, 'TRANSFER_OUT')],
  });
  if (result.errors.length > 0) {
    throw new Error(
      `saveMany reported per-item errors for candidate ${sfTransactionId}: ${JSON.stringify(result.errors)}`,
    );
  }
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

  const active: StagedCandidate[] = [];
  for (const candidate of candidates) {
    const postedSeconds = Date.parse(candidate.postedDate) / 1000;
    if (!candidate.backfilled && nowSeconds - postedSeconds > EXPIRY_DAYS * SECONDS_PER_DAY) {
      expired += 1;
      continue;
    }
    active.push(candidate);
  }

  // The withdrawal pool searched is identical for every candidate in this
  // run (same cashAccountIds) — fetch it once rather than once per
  // candidate, skipping the call entirely when nothing is left to check or
  // when there's no cash account to search (an empty accountIds filter is
  // not safe to send — the host may treat it as "no filter", pulling in
  // every WITHDRAWAL in the portfolio).
  const withdrawals =
    active.length > 0 && cashAccountIds.length > 0 ? await searchAllByType(api, cashAccountIds, 'WITHDRAWAL') : [];

  // Withdrawals already claimed by an earlier candidate's unique match in
  // this same run — excluded from subsequent candidates' pools so two
  // same-amount, overlapping-window candidates can't both reclassify the
  // same real withdrawal.
  const claimedWithdrawalIds = new Set<string>();

  for (const candidate of active) {
    try {
      const cardRow = await findCardActivity(api, candidate);
      if (!cardRow) {
        // Host indexing lag or a transaction detected but not yet settled —
        // retry on the next sync run.
        remaining.push(candidate);
        continue;
      }

      const matches = withdrawalMatches(withdrawals, candidate).filter((w) => !claimedWithdrawalIds.has(w.id));

      if (matches.length === 0) {
        remaining.push({ ...candidate, cardActivityId: cardRow.id, status: 'pending', candidateWithdrawalIds: [] });
        continue;
      }
      if (matches.length > 1) {
        remaining.push({
          ...candidate,
          cardActivityId: cardRow.id,
          status: 'ambiguous',
          candidateWithdrawalIds: matches.map((w) => w.id),
        });
        continue;
      }

      await reclassifyPair(api, cardRow, matches[0], candidate.sfTransactionId);
      claimedWithdrawalIds.add(matches[0].id);
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

  await reclassifyPair(api, cardRow, withdrawalRow, candidate.sfTransactionId);
}
