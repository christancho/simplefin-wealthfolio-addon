# Backfill-Relink Pre-Existing Unlinked Transfer Pairs — Design

Implements [#71](https://github.com/christancho/simplefin-wealthfolio-addon/issues/71).

## Problem

#69 / PR #70 fixed `reclassifyPair()` (`src/lib/sync/reconciliation.ts`) so
newly-reconciled transfers get linked via `sourceGroupId`, stopping
Wealthfolio's Data Consistency checker from flagging them as incomplete
transfers going forward. It does nothing for transfers already reclassified
to `TRANSFER_IN`/`TRANSFER_OUT` by the old `update()`-based code before that
fix landed — 28 in production as of 2026-08-26, confirmed still flagged
after installing the fix and running a fresh sync.

Two independent reasons the existing pipeline never revisits them:

1. Reclassification is one-shot — once `reclassifyPair()` resolves a
   candidate, `runReconciliation` drops it from `remaining` and it's never
   processed again.
2. The backfill scanner (`findBackfillCandidatesOfType`,
   `reconciliation.ts:140`) only searches `CREDIT`/`DEPOSIT` activities —
   activities already typed `TRANSFER_IN`/`TRANSFER_OUT` never match that
   search, so they're invisible to it.

## Design

### New matching function, reusing existing pieces

`withdrawalMatches` (`reconciliation.ts:93`) already does exactly the
matching this needs — same amount, opposite account, within
`MATCH_WINDOW_DAYS` — but its signature takes a `StagedCandidate`. Generalize
it to take a narrower shape instead, so both the existing candidate-matching
path and the new backfill-relink path can share it:

```ts
type MatchTarget = Pick<StagedCandidate, 'inflowAccountId' | 'amount' | 'postedDate'>;

function withdrawalMatches(withdrawals: ActivityDetails[], target: MatchTarget): ActivityDetails[] {
  // body unchanged except `candidate.` -> `target.`
}
```

A `StagedCandidate` already structurally satisfies `MatchTarget`, so every
existing call site (`runReconciliation`) needs no change beyond the
parameter type.

### Reading `sourceGroupId` off search results

`ActivityDetails` (returned by `activities.search()`) doesn't declare
`sourceGroupId` in the SDK's shipped types — only `Activity` (the shape
`create`/`update`/`saveMany` return) does. The 2026-08-26 live probe already
established the field is present in the runtime JSON regardless (it read it
off a fresh `search()` call successfully via a cast). Add the same cast as a
small named helper so every read site is consistent:

```ts
/**
 * `sourceGroupId` is on the host's `Activity` model but missing from the
 * SDK's `ActivityDetails` type — confirmed present in the runtime JSON
 * regardless (2026-08-26 live probe). This cast is the one place that gap
 * is bridged; every other read goes through this function.
 */
function sourceGroupIdOf(row: ActivityDetails): string | null {
  return ((row as unknown as Record<string, unknown>).sourceGroupId as string | null | undefined) ?? null;
}
```

### `relinkUnlinkedTransferPairs`

```ts
export interface RelinkSummary {
  relinked: number;
  ambiguous: number;
}

export async function relinkUnlinkedTransferPairs(
  api: HostAPI,
  inflowAccountIds: string[],
  cashAccountIds: string[],
): Promise<RelinkSummary> {
  if (inflowAccountIds.length === 0 || cashAccountIds.length === 0) {
    return { relinked: 0, ambiguous: 0 };
  }

  const [transferIns, transferOuts] = await Promise.all([
    searchAllByType(api, inflowAccountIds, 'TRANSFER_IN'),
    searchAllByType(api, cashAccountIds, 'TRANSFER_OUT'),
  ]);
  const unlinkedIns = transferIns.filter((r) => !sourceGroupIdOf(r));
  const unlinkedOuts = transferOuts.filter((r) => !sourceGroupIdOf(r));

  let relinked = 0;
  let ambiguous = 0;
  const claimedOutIds = new Set<string>();

  for (const inRow of unlinkedIns) {
    const target: MatchTarget = {
      inflowAccountId: inRow.accountId,
      amount: inRow.amount ?? '0',
      postedDate: toIsoDateOnly(inRow.date),
    };
    const matches = withdrawalMatches(unlinkedOuts, target).filter((o) => !claimedOutIds.has(o.id));

    if (matches.length === 0) continue;
    if (matches.length > 1) {
      ambiguous += 1;
      continue;
    }

    try {
      await reclassifyPair(api, inRow, matches[0], inRow.id);
      claimedOutIds.add(matches[0].id);
      relinked += 1;
    } catch (error) {
      api.logger.error(`[simplefin] relink failed for TRANSFER_IN ${inRow.id}: ${String(error)}`);
    }
  }

  return { relinked, ambiguous };
}
```

`inflowAccountIds` is the union of card and cash account ids (`TRANSFER_IN`
can land on either, mirroring how `CREDIT`/`DEPOSIT` did before
reclassification); `cashAccountIds` alone for `TRANSFER_OUT`, since money
only ever leaves a cash account — identical to how `withdrawalMatches`'
existing account-exclusion logic already treats `WITHDRAWAL`.

`reclassifyPair(api, inRow, matches[0], inRow.id)` is called directly, unchanged
— it already deletes both rows and recreates them typed `TRANSFER_IN`/
`TRANSFER_OUT` with `sourceGroupId` set (using `inRow.id` as the grouping key,
the same "reuse the deleted row's own id" precedent
`findBackfillCandidatesOfType` already established for backfilled
candidates — see the comment at `reconciliation.ts:155`). The two rows keep
the same activity type they already had; only the link and the previously-
dropped `fee`/`subtype` fields change.

**Deliberately no ambiguous-match UI.** Every existing `TRANSFER_IN`/
`TRANSFER_OUT` pair was created by a *past* unambiguous match — that's the
only way `reclassifyPair` was ever called. Re-deriving that same match now
should essentially never produce ambiguity unless a new, coincidentally
same-amount transaction has appeared since. Building staged-candidate/UI
plumbing for that rare case isn't worth the complexity; `ambiguous` is
counted and surfaced in the scan result text so it isn't silent, but the
pair is simply left alone (still unlinked, still flagged by Wealthfolio,
exactly as it was before running the scan).

Note this population is not limited to pairs this addon itself created:
`relinkUnlinkedTransferPairs` matches *any* unlinked `TRANSFER_IN`/
`TRANSFER_OUT` pair in the mapped accounts, regardless of what created it —
a manual entry, a CSV import, or another addon are just as eligible as this
addon's own past reclassifications, since Wealthfolio's Data Consistency
checker doesn't distinguish by provenance either, only by whether the link
exists.

### Trigger: fold into the existing "Scan" button

`StagedTransactionsList.tsx`'s `scanForOlderPayments` already exists as the
opt-in, manual action for "catch up on anything the live pipeline missed" —
the button was already renamed once (see commit `f66643c`) to reflect
scope growing beyond payments into transfers. This is the same story again:
add a call to `relinkUnlinkedTransferPairs` alongside the existing
`findBackfillCandidates`/`runReconciliation` calls, in the same handler, and
extend the button/result text to mention it.

This is a deliberate choice, not just convenience: per the risk note in
issue #71, delete+recreate on activities that can be arbitrarily older than
the ~7-day live-candidate window carries more risk of losing something
keyed to the old activity id (e.g. manual categorization) than the original
fix's few-day window ever did. Keeping it behind the same explicit,
user-initiated action — never automatic on every sync — is the mitigation;
nothing here changes `runSync`.

**Result visibility.** Per the project's rule against fire-and-forget
operations, the scan's outcome must be visible, not just logged. Add a
result-summary state that renders under the button after a scan completes,
covering both the existing backfill count and the new relink/ambiguous
counts (e.g. "Found 2 new candidates. Relinked 5 pairs, 0 ambiguous.") —
shown even when all counts are zero, so a no-op scan isn't silent either.

## Testing

- `reconciliation.test.ts`: new tests for `relinkUnlinkedTransferPairs`
  covering — unambiguous relink calls `saveMany` with the expected
  `creates`/`deleteIds` shape and `sourceGroupId: <transferIn.id>`; a row
  with `sourceGroupId` already set is excluded from matching entirely; zero
  matches is a no-op; 2+ matches increments `ambiguous` and calls `saveMany`
  zero times for that row; a `reclassifyPair` failure for one row doesn't
  block a later row in the same run (mirrors the existing per-candidate
  isolation test in `runReconciliation`); empty `inflowAccountIds` or
  `cashAccountIds` returns `{ relinked: 0, ambiguous: 0 }` without calling
  `search`.
- `withdrawalMatches`'s existing test coverage (indirectly, via
  `runReconciliation`'s tests) continues to exercise it unchanged after the
  `StagedCandidate` → `MatchTarget` signature generalization — no behavior
  change, so no new tests needed for that piece alone.
- `StagedTransactionsList.test.tsx`: extend the existing scan-button test(s)
  to cover the new relink call and the result-summary text.
