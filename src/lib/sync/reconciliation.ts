import type { ActivityCreate, ActivityDetails, HostAPI } from '@wealthfolio/addon-sdk';
import type { InflowActivityType, StagedCandidate } from '../storage/staging';
import { isPaymentCandidate } from './activities';
import { normalise } from './balance';

/**
 * Unresolved candidate older than this, from its inflow leg's posted date,
 * drops out of staging without creating a transfer — required by issue #50
 * so the staged list can't grow unbounded when a pair genuinely never
 * appears (e.g. paid from an untracked account).
 */
export const EXPIRY_DAYS = 7;

/**
 * The withdrawal leg typically lands up to this many days before the inflow
 * leg's activity posts — required by issue #50's matching window.
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
 * Resolves a staged candidate's real inflow-side activity — a card `CREDIT`
 * or a cash-account `DEPOSIT`, per `candidate.inflowActivityType`. Once
 * `inflowActivityId` is known, looks it up directly; otherwise matches by
 * account/amount/date/comment (the only info staged at detection time,
 * since `import()`'s response never carries the real persisted id).
 */
export async function findInflowActivity(api: HostAPI, candidate: StagedCandidate): Promise<ActivityDetails | null> {
  const rows = await searchAllByType(api, [candidate.inflowAccountId], candidate.inflowActivityType);
  if (candidate.inflowActivityId) {
    return rows.find((r) => r.id === candidate.inflowActivityId) ?? null;
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
 * The subset of a candidate's fields `withdrawalMatches` actually needs —
 * lets a non-candidate caller (`relinkUnlinkedTransferPairs`) reuse the same
 * matching logic without constructing a full `StagedCandidate`.
 */
type MatchTarget = Pick<StagedCandidate, 'inflowAccountId' | 'amount' | 'postedDate'>;

/**
 * Filters an already-fetched withdrawal pool down to this target's matches
 * (same amount, posted within the match window, in an account other than
 * the target's own inflow account). Pure and synchronous on purpose — the
 * withdrawal pool is identical for every candidate in a run, so callers
 * fetch it once via `searchAllByType` and reuse it across candidates rather
 * than re-fetching per candidate.
 *
 * The same-account exclusion matters only for a cash-to-cash transfer
 * candidate — its own account is part of the withdrawal search pool, unlike
 * a credit-card candidate's account, which `cashAccountIdsFrom` already
 * excludes from that pool. Without it, a transfer's destination account
 * could match a withdrawal sitting in that very account.
 */
function withdrawalMatches(withdrawals: ActivityDetails[], target: MatchTarget): ActivityDetails[] {
  const inflowPostedSeconds = Date.parse(target.postedDate) / 1000;
  const windowStartSeconds = inflowPostedSeconds - MATCH_WINDOW_DAYS * SECONDS_PER_DAY;

  return withdrawals.filter((w) => {
    if (w.accountId === target.inflowAccountId) return false;
    const postedSeconds = Date.parse(toIsoDateOnly(w.date)) / 1000;
    return (
      normalise(w.amount ?? '0') === normalise(target.amount) &&
      postedSeconds >= windowStartSeconds &&
      postedSeconds <= inflowPostedSeconds
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
    c.inflowActivityId
      ? c.inflowActivityId === row.id
      : c.inflowAccountId === row.accountId &&
        normalise(c.amount) === normalise(row.amount ?? '0') &&
        c.postedDate === toIsoDateOnly(row.date) &&
        c.comment === (row.comment ?? ''),
  );
}

/**
 * Scans already-imported inflow activities (`CREDIT` on the given card
 * accounts, `DEPOSIT` on the given cash accounts) for ones that look like a
 * bill payment or an internal transfer but were never staged — either
 * because they predate this feature, or because the sync that imported them
 * ran before detection existed. Unlike live detection, the Wealthfolio
 * activity already exists, so `inflowActivityId` is known immediately; no
 * fuzzy lookup is needed later. See `StagedCandidate.backfilled` for why
 * these are exempt from the normal expiry sweep.
 */
async function findBackfillCandidatesOfType(
  api: HostAPI,
  accountIds: string[],
  inflowActivityType: InflowActivityType,
  keywords: string[],
  existingStaging: StagedCandidate[],
): Promise<StagedCandidate[]> {
  if (accountIds.length === 0) return [];

  const rows = await searchAllByType(api, accountIds, inflowActivityType);

  return rows
    .filter((row) => isPaymentCandidate(row.comment ?? '', keywords))
    .filter((row) => !isAlreadyStaged(row, existingStaging))
    .map((row) => ({
      // Reused as `sourceGroupId` in `reclassifyPair`, which deletes the very
      // activity `row.id` names here — that's fine, since a grouping key
      // only needs to be unique and stable, not point at a surviving row.
      sfTransactionId: row.id,
      inflowAccountId: row.accountId,
      inflowActivityId: row.id,
      inflowActivityType,
      amount: row.amount ?? '0',
      currency: row.currency,
      postedDate: toIsoDateOnly(row.date),
      comment: row.comment ?? '',
      status: 'pending' as const,
      candidateWithdrawalIds: [],
      backfilled: true,
    }));
}

export async function findBackfillCandidates(
  api: HostAPI,
  cardAccountIds: string[],
  paymentKeywords: string[],
  cashAccountIds: string[],
  transferKeywords: string[],
  existingStaging: StagedCandidate[],
): Promise<StagedCandidate[]> {
  const [cardCandidates, cashCandidates] = await Promise.all([
    findBackfillCandidatesOfType(api, cardAccountIds, 'CREDIT', paymentKeywords, existingStaging),
    findBackfillCandidatesOfType(api, cashAccountIds, 'DEPOSIT', transferKeywords, existingStaging),
  ]);
  return [...cardCandidates, ...cashCandidates];
}

function toCreate(row: ActivityDetails, activityType: string, sourceGroupId: string): ActivityCreate {
  return {
    accountId: row.accountId,
    activityType,
    activityDate: row.date,
    amount: row.amount ?? '0',
    currency: row.currency,
    comment: row.comment,
    fee: row.fee,
    tax: row.tax,
    fxRate: row.fxRate,
    metadata: row.metadata,
    subtype: row.subtype,
    sourceGroupId,
  };
}

/**
 * Reclassifying via `activities.update()` was tried first (see the
 * 2026-08-14 design doc) and confirmed against a live host to silently drop
 * `sourceGroupId` — the two legs ended up correctly typed but never linked,
 * which is invisible to `update()` but visible to Wealthfolio's own Data
 * Consistency checker. A follow-up live-host probe (2026-08-26) confirmed
 * `saveMany({ creates: [...] })` does persist it, so both legs are deleted
 * and recreated instead of updated in place, linked by the candidate's own
 * `sfTransactionId` as a shared `sourceGroupId`.
 *
 * Both legs are still created/deleted in a single `saveMany()` call rather
 * than sequential calls, for the same reason as before: `findInflowActivity()`
 * only ever searches `candidate.inflowActivityType`, so if the inflow leg
 * alone were recreated as `TRANSFER_IN` and the withdrawal leg's write then
 * failed, the next reconciliation attempt could never re-find the (now
 * non-CREDIT/DEPOSIT) inflow activity — leaving the pair permanently
 * half-reclassified. One request, one failure path avoids that split-write
 * state.
 *
 * `saveMany` can also resolve successfully while still reporting a per-item
 * failure in `result.errors` rather than throwing — that's checked here and
 * turned into a thrown error so the caller's existing catch/retry path (in
 * `runReconciliation`) treats it the same as a hard failure, instead of
 * counting the candidate resolved while one or both legs never actually
 * changed.
 *
 * A single call is not the same as an atomic one, though. If the creates
 * apply but the deletes don't, the original inflow activity is still sitting
 * there as `CREDIT`/`DEPOSIT`, so the next reconciliation run will find it
 * again and reclassify it a second time — producing a duplicate linked pair,
 * unlike the old `update()` approach, which was naturally idempotent to
 * retry. If the deletes apply but the creates don't, both original
 * activities are gone with nothing written to replace them — unrecoverable
 * data loss, not just a stuck pending candidate. Both failure modes are
 * believed rare (a single host call either round-trips or it doesn't), but
 * neither is actually solved by making it one request.
 */
async function reclassifyPair(
  api: HostAPI,
  inflowRow: ActivityDetails,
  withdrawalRow: ActivityDetails,
  sfTransactionId: string,
): Promise<void> {
  const result = await api.activities.saveMany({
    creates: [
      toCreate(inflowRow, 'TRANSFER_IN', sfTransactionId),
      toCreate(withdrawalRow, 'TRANSFER_OUT', sfTransactionId),
    ],
    deleteIds: [inflowRow.id, withdrawalRow.id],
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
 * otherwise resolve its real inflow-side activity and search for matching
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
    // Pre-rename record from an older version of this addon (before
    // `cardAccountId`/`cardActivityId` became `inflowAccountId`/
    // `inflowActivityId` and `inflowActivityType` was added): these fields
    // read as undefined under the current StagedCandidate shape, so there is
    // nothing valid to search for. Drop it the same way a time-expired
    // candidate is dropped, rather than sending an unfiltered/undefined
    // search to the host (see searchAllByType's caveat below on why an
    // empty accountIds filter is unsafe — the same doubt applies here).
    if (!candidate.inflowAccountId || !candidate.inflowActivityType) {
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
  // same-amount, overlapping-window candidates (whether both card payments,
  // both cash transfers, or one of each) can't both reclassify the same
  // real withdrawal.
  const claimedWithdrawalIds = new Set<string>();

  for (const candidate of active) {
    try {
      const inflowRow = await findInflowActivity(api, candidate);
      if (!inflowRow) {
        // Host indexing lag or a transaction detected but not yet settled —
        // retry on the next sync run.
        remaining.push(candidate);
        continue;
      }

      const matches = withdrawalMatches(withdrawals, candidate).filter((w) => !claimedWithdrawalIds.has(w.id));

      if (matches.length === 0) {
        remaining.push({ ...candidate, inflowActivityId: inflowRow.id, status: 'pending', candidateWithdrawalIds: [] });
        continue;
      }
      if (matches.length > 1) {
        remaining.push({
          ...candidate,
          inflowActivityId: inflowRow.id,
          status: 'ambiguous',
          candidateWithdrawalIds: matches.map((w) => w.id),
        });
        continue;
      }

      await reclassifyPair(api, inflowRow, matches[0], candidate.sfTransactionId);
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
  const inflowRow = await findInflowActivity(api, candidate);
  if (!inflowRow) {
    throw new Error(`Could not find the inflow activity for candidate ${candidate.sfTransactionId}`);
  }

  const withdrawals = await searchAllByType(api, cashAccountIds, 'WITHDRAWAL');
  const withdrawalRow = withdrawals.find((w) => w.id === chosenWithdrawalId);
  if (!withdrawalRow) {
    throw new Error(`Could not find withdrawal ${chosenWithdrawalId}`);
  }

  await reclassifyPair(api, inflowRow, withdrawalRow, candidate.sfTransactionId);
}

/**
 * `sourceGroupId` is on the host's `Activity` model but missing from the
 * SDK's `ActivityDetails` type — confirmed present in the runtime JSON
 * regardless (2026-08-26 live probe, see the design doc). This cast is the
 * one place that gap is bridged; every other read goes through this
 * function.
 */
function sourceGroupIdOf(row: ActivityDetails): string | null {
  return ((row as unknown as Record<string, unknown>).sourceGroupId as string | null | undefined) ?? null;
}

export interface RelinkSummary {
  relinked: number;
  unmatched: number;
  ambiguous: number;
  failed: number;
}

/**
 * Finds any `TRANSFER_IN`/`TRANSFER_OUT` activity in the mapped accounts
 * that is missing `sourceGroupId` and relinks unambiguous 1:1 matches via
 * `reclassifyPair`. This is deliberately provenance-agnostic: it doesn't
 * matter whether a row was reclassified by this addon before `sourceGroupId`
 * linking existed, entered manually, imported from a CSV, or created by
 * another addon entirely — Wealthfolio's own Data Consistency checker
 * doesn't care about provenance either, only about whether the link exists.
 *
 * Matching runs in passes: a row with 2+ candidates is set aside as
 * ambiguous for the pass rather than staged, then retried in the next pass,
 * since another row's successful claim can shrink its candidate pool down to
 * exactly one. A row with zero matches is never retried — claiming a
 * `TRANSFER_OUT` elsewhere can't conjure up a new match for a row that
 * already had none. Passes stop once one makes no further progress, at which
 * point any rows still ambiguous are counted and left alone rather than
 * staged for manual resolution — the same reasoning as before: every
 * existing pair was originally created by *some* unambiguous match, so
 * lingering ambiguity here should be rare.
 */
export async function relinkUnlinkedTransferPairs(
  api: HostAPI,
  inflowAccountIds: string[],
  cashAccountIds: string[],
): Promise<RelinkSummary> {
  if (inflowAccountIds.length === 0 || cashAccountIds.length === 0) {
    return { relinked: 0, unmatched: 0, ambiguous: 0, failed: 0 };
  }

  const [transferIns, transferOuts] = await Promise.all([
    searchAllByType(api, inflowAccountIds, 'TRANSFER_IN'),
    searchAllByType(api, cashAccountIds, 'TRANSFER_OUT'),
  ]);
  const unlinkedIns = transferIns.filter((r) => !sourceGroupIdOf(r));
  const unlinkedOuts = transferOuts.filter((r) => !sourceGroupIdOf(r));

  api.logger.info(
    `[simplefin] relink scan: ${unlinkedIns.length}/${transferIns.length} TRANSFER_IN unlinked, ${unlinkedOuts.length}/${transferOuts.length} TRANSFER_OUT unlinked`,
  );

  let relinked = 0;
  let unmatched = 0;
  let ambiguous = 0;
  let failed = 0;
  const claimedOutIds = new Set<string>();

  let pending = unlinkedIns;
  for (;;) {
    const stillAmbiguous: ActivityDetails[] = [];
    let progressed = false;

    for (const inRow of pending) {
      const target: MatchTarget = {
        inflowAccountId: inRow.accountId,
        amount: inRow.amount ?? '0',
        postedDate: toIsoDateOnly(inRow.date),
      };
      const matches = withdrawalMatches(unlinkedOuts, target).filter((o) => !claimedOutIds.has(o.id));

      if (matches.length === 0) {
        unmatched += 1;
        continue;
      }
      if (matches.length > 1) {
        stillAmbiguous.push(inRow);
        continue;
      }

      try {
        await reclassifyPair(api, inRow, matches[0], inRow.id);
        claimedOutIds.add(matches[0].id);
        relinked += 1;
        progressed = true;
      } catch (error) {
        api.logger.error(`[simplefin] relink failed for TRANSFER_IN ${inRow.id}: ${String(error)}`);
        failed += 1;
      }
    }

    if (!progressed || stillAmbiguous.length === 0) {
      ambiguous += stillAmbiguous.length;
      break;
    }
    pending = stillAmbiguous;
  }

  return { relinked, unmatched, ambiguous, failed };
}
