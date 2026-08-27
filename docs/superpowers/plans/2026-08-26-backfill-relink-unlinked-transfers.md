# Backfill-Relink Pre-Existing Unlinked Transfer Pairs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Find `TRANSFER_IN`/`TRANSFER_OUT` activities reclassified before `sourceGroupId` linking existed and relink unambiguous 1:1 matches, so Wealthfolio's Data Consistency checker stops flagging them — without touching the live sync path.

**Architecture:** A new `relinkUnlinkedTransferPairs` function (`src/lib/sync/reconciliation.ts`) searches already-typed `TRANSFER_IN`/`TRANSFER_OUT` activities missing `sourceGroupId`, matches them pairwise by reusing the existing `withdrawalMatches` logic (generalized to accept a narrower shape than a full `StagedCandidate`), and relinks unambiguous matches via the existing `reclassifyPair`. It's wired into the existing "Scan for older payments and transfers" button (`StagedTransactionsList.tsx`) rather than run automatically on every sync, since it operates on activities that can be arbitrarily older than the ~7-day window live candidates ever reach.

**Tech Stack:** TypeScript, Vitest, React Testing Library, `@wealthfolio/addon-sdk`.

**Spec:** `docs/superpowers/specs/2026-08-26-backfill-relink-unlinked-transfers-design.md`

## Global Constraints

- No new UI for ambiguous matches — count them, leave the pair alone, never stage them.
- Never call `relinkUnlinkedTransferPairs` from `runSync` or any automatic path — manual "Scan" button only.
- `sourceGroupId` for a relinked pair is the `TRANSFER_IN` row's own `id` (same "reuse the deleted row's own id" precedent already used for backfilled candidates in `findBackfillCandidatesOfType`).
- Reuse `reclassifyPair` unchanged — do not duplicate its delete+recreate logic.

---

### Task 1: `relinkUnlinkedTransferPairs` in `reconciliation.ts`

**Files:**
- Modify: `src/lib/sync/reconciliation.ts:93-106` (generalize `withdrawalMatches`), append new code after line 377 (end of file)
- Test: `src/lib/sync/reconciliation.test.ts` (new `describe('relinkUnlinkedTransferPairs', ...)` block)

**Interfaces:**
- Consumes: `searchAllByType`, `reclassifyPair`, `toIsoDateOnly`, `normalise`, `MATCH_WINDOW_DAYS`, `SECONDS_PER_DAY` — all already in this file.
- Produces: `export async function relinkUnlinkedTransferPairs(api: HostAPI, inflowAccountIds: string[], cashAccountIds: string[]): Promise<RelinkSummary>` where `RelinkSummary = { relinked: number; ambiguous: number }` — Task 2 calls this directly.

- [ ] **Step 1: Generalize `withdrawalMatches` to accept a `MatchTarget` instead of a full `StagedCandidate`**

Replace lines 79-106 of `src/lib/sync/reconciliation.ts`:

```ts
/**
 * Filters an already-fetched withdrawal pool down to this candidate's
 * matches (same amount, posted within the match window, in an account other
 * than the candidate's own inflow account). Pure and synchronous on purpose
 * — the withdrawal pool is identical for every candidate in a run, so
 * callers fetch it once via `searchAllByType` and reuse it across
 * candidates rather than re-fetching per candidate.
 *
 * The same-account exclusion matters only for a cash-to-cash transfer
 * candidate — its own account is part of the withdrawal search pool, unlike
 * a credit-card candidate's account, which `cashAccountIdsFrom` already
 * excludes from that pool. Without it, a transfer's destination account
 * could match a withdrawal sitting in that very account.
 */
function withdrawalMatches(withdrawals: ActivityDetails[], candidate: StagedCandidate): ActivityDetails[] {
  const inflowPostedSeconds = Date.parse(candidate.postedDate) / 1000;
  const windowStartSeconds = inflowPostedSeconds - MATCH_WINDOW_DAYS * SECONDS_PER_DAY;

  return withdrawals.filter((w) => {
    if (w.accountId === candidate.inflowAccountId) return false;
    const postedSeconds = Date.parse(toIsoDateOnly(w.date)) / 1000;
    return (
      normalise(w.amount ?? '0') === normalise(candidate.amount) &&
      postedSeconds >= windowStartSeconds &&
      postedSeconds <= inflowPostedSeconds
    );
  });
}
```

with:

```ts
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
```

(This is a pure signature generalization — `runReconciliation`'s existing call site at line ~327, `withdrawalMatches(withdrawals, candidate)`, needs no change: a `StagedCandidate` already structurally satisfies `MatchTarget`.)

- [ ] **Step 2: Run the existing suite to confirm the generalization is behavior-preserving**

Run: `pnpm test -- reconciliation.test.ts`
Expected: PASS — all existing tests in this file still pass unchanged (no behavior change yet, just a type generalization).

- [ ] **Step 3: Append `sourceGroupIdOf`, `RelinkSummary`, and `relinkUnlinkedTransferPairs` to the end of `src/lib/sync/reconciliation.ts`**

Append after the current last line (377, the closing brace of `resolveAmbiguous`):

```ts

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
  ambiguous: number;
}

/**
 * Finds `TRANSFER_IN`/`TRANSFER_OUT` activities reclassified before
 * `sourceGroupId` linking existed (or by any other means that left them
 * unlinked) and relinks unambiguous 1:1 matches via `reclassifyPair`.
 *
 * Deliberately does not surface ambiguous matches for manual resolution the
 * way live candidates do — every existing pair here was created by a past
 * *unambiguous* match (that's the only way `reclassifyPair` is ever
 * called), so re-deriving that same match now should essentially never
 * produce ambiguity. `ambiguous` is counted so a caller can still report it,
 * but the pair is simply left alone rather than staged.
 */
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

- [ ] **Step 4: Add tests to `src/lib/sync/reconciliation.test.ts`**

Add fixture helpers near the top of the file, alongside the existing `cardActivity`/`withdrawalActivity` helpers:

```ts
const transferInActivity = (over: Partial<ActivityDetails> & { sourceGroupId?: string | null } = {}): ActivityDetails =>
  ({
    id: 'TIN-1',
    accountId: 'WF-CARD',
    activityType: 'TRANSFER_IN',
    date: '2025-08-06T00:00:00+00:00',
    amount: '50',
    currency: 'USD',
    comment: 'Old payment',
    sourceGroupId: null,
    ...over,
  }) as ActivityDetails;

const transferOutActivity = (over: Partial<ActivityDetails> & { sourceGroupId?: string | null } = {}): ActivityDetails =>
  ({
    id: 'TOUT-1',
    accountId: 'WF-CASH',
    activityType: 'TRANSFER_OUT',
    date: '2025-08-05T00:00:00+00:00',
    amount: '50',
    currency: 'USD',
    comment: 'Old withdrawal',
    sourceGroupId: null,
    ...over,
  }) as ActivityDetails;
```

Add this import to the top of the file: `relinkUnlinkedTransferPairs` alongside the other named imports from `./reconciliation`.

Add a new `describe` block (anywhere after the existing ones, e.g. at the end of the file):

```ts
describe('relinkUnlinkedTransferPairs', () => {
  it('relinks an unambiguous unlinked pair via saveMany, using the TRANSFER_IN id as sourceGroupId', async () => {
    const host = createMockHost();
    host.api.activities.search = vi.fn(async (_p: number, _s: number, filters: { activityTypes: string }) => {
      if (filters.activityTypes === 'TRANSFER_IN') return { data: [transferInActivity()], meta: { totalRowCount: 1 } };
      if (filters.activityTypes === 'TRANSFER_OUT') return { data: [transferOutActivity()], meta: { totalRowCount: 1 } };
      return { data: [], meta: { totalRowCount: 0 } };
    }) as never;

    const result = await relinkUnlinkedTransferPairs(host.api, ['WF-CARD'], ['WF-CASH']);

    expect(result).toEqual({ relinked: 1, ambiguous: 0 });
    expect(host.api.activities.saveMany).toHaveBeenCalledWith({
      creates: [
        expect.objectContaining({ accountId: 'WF-CARD', activityType: 'TRANSFER_IN', sourceGroupId: 'TIN-1' }),
        expect.objectContaining({ accountId: 'WF-CASH', activityType: 'TRANSFER_OUT', sourceGroupId: 'TIN-1' }),
      ],
      deleteIds: ['TIN-1', 'TOUT-1'],
    });
  });

  it('excludes a row that already has sourceGroupId set from matching entirely', async () => {
    const host = createMockHost();
    host.api.activities.search = vi.fn(async (_p: number, _s: number, filters: { activityTypes: string }) => {
      if (filters.activityTypes === 'TRANSFER_IN') {
        return { data: [transferInActivity({ sourceGroupId: 'already-linked' })], meta: { totalRowCount: 1 } };
      }
      if (filters.activityTypes === 'TRANSFER_OUT') return { data: [transferOutActivity()], meta: { totalRowCount: 1 } };
      return { data: [], meta: { totalRowCount: 0 } };
    }) as never;

    const result = await relinkUnlinkedTransferPairs(host.api, ['WF-CARD'], ['WF-CASH']);

    expect(result).toEqual({ relinked: 0, ambiguous: 0 });
    expect(host.api.activities.saveMany).not.toHaveBeenCalled();
  });

  it('leaves a TRANSFER_IN with zero withdrawal matches unlinked', async () => {
    const host = createMockHost();
    host.api.activities.search = vi.fn(async (_p: number, _s: number, filters: { activityTypes: string }) => {
      if (filters.activityTypes === 'TRANSFER_IN') return { data: [transferInActivity()], meta: { totalRowCount: 1 } };
      return { data: [], meta: { totalRowCount: 0 } };
    }) as never;

    const result = await relinkUnlinkedTransferPairs(host.api, ['WF-CARD'], ['WF-CASH']);

    expect(result).toEqual({ relinked: 0, ambiguous: 0 });
    expect(host.api.activities.saveMany).not.toHaveBeenCalled();
  });

  it('counts ambiguous and does not call saveMany when 2+ matches exist for a row', async () => {
    const host = createMockHost();
    host.api.activities.search = vi.fn(async (_p: number, _s: number, filters: { activityTypes: string }) => {
      if (filters.activityTypes === 'TRANSFER_IN') return { data: [transferInActivity()], meta: { totalRowCount: 1 } };
      if (filters.activityTypes === 'TRANSFER_OUT') {
        return {
          data: [transferOutActivity(), transferOutActivity({ id: 'TOUT-2', accountId: 'WF-CASH-2' })],
          meta: { totalRowCount: 2 },
        };
      }
      return { data: [], meta: { totalRowCount: 0 } };
    }) as never;

    const result = await relinkUnlinkedTransferPairs(host.api, ['WF-CARD'], ['WF-CASH', 'WF-CASH-2']);

    expect(result).toEqual({ relinked: 0, ambiguous: 1 });
    expect(host.api.activities.saveMany).not.toHaveBeenCalled();
  });

  it("isolates a per-row failure so a later row still relinks", async () => {
    const host = createMockHost();
    host.api.activities.search = vi.fn(async (_p: number, _s: number, filters: { activityTypes: string }) => {
      if (filters.activityTypes === 'TRANSFER_IN') {
        return {
          data: [transferInActivity({ id: 'TIN-BAD' }), transferInActivity({ id: 'TIN-GOOD' })],
          meta: { totalRowCount: 2 },
        };
      }
      if (filters.activityTypes === 'TRANSFER_OUT') {
        return {
          data: [transferOutActivity({ id: 'TOUT-BAD' }), transferOutActivity({ id: 'TOUT-GOOD' })],
          meta: { totalRowCount: 2 },
        };
      }
      return { data: [], meta: { totalRowCount: 0 } };
    }) as never;
    host.api.activities.saveMany = vi.fn(async (req: { deleteIds?: string[] }) => {
      if (req.deleteIds?.includes('TIN-BAD')) {
        return { created: [], updated: [], deleted: [], createdMappings: [], errors: [{ id: 'TIN-BAD', action: 'create', message: 'boom' }] };
      }
      return { created: [], updated: [], deleted: [], createdMappings: [], errors: [] };
    }) as never;

    const result = await relinkUnlinkedTransferPairs(host.api, ['WF-CARD'], ['WF-CASH']);

    expect(result.relinked).toBe(1);
    expect(host.api.logger.error).toHaveBeenCalledWith(expect.stringContaining('TIN-BAD'));
  });

  it('returns zero counts without searching when inflowAccountIds is empty', async () => {
    const host = createMockHost();
    host.api.activities.search = vi.fn();

    const result = await relinkUnlinkedTransferPairs(host.api, [], ['WF-CASH']);

    expect(result).toEqual({ relinked: 0, ambiguous: 0 });
    expect(host.api.activities.search).not.toHaveBeenCalled();
  });

  it('returns zero counts without searching when cashAccountIds is empty', async () => {
    const host = createMockHost();
    host.api.activities.search = vi.fn();

    const result = await relinkUnlinkedTransferPairs(host.api, ['WF-CARD'], []);

    expect(result).toEqual({ relinked: 0, ambiguous: 0 });
    expect(host.api.activities.search).not.toHaveBeenCalled();
  });
});
```

Note the two `transferOutActivity({ id: 'TOUT-BAD' })`/`transferOutActivity({ id: 'TOUT-GOOD' })` fixtures in the isolation test both default to `accountId: 'WF-CASH'` and the same `date`/`amount` as the two TRANSFER_IN rows — since both TRANSFER_IN rows also share the same amount/date by default, each independently matches both TRANSFER_OUT rows unless claimed. Verify while implementing that `TIN-BAD` and `TIN-GOOD` don't cross-match each other's intended partner ambiguously — if the test as written produces `ambiguous` instead of one clean success and one clean failure, adjust the fixtures' `id`s only (keep amounts/dates matching, differentiate accounts if needed, e.g. give `TOUT-GOOD`/`TIN-GOOD` a different `accountId` pair like `WF-CASH-2`) so each TRANSFER_IN has exactly one matching TRANSFER_OUT.

- [ ] **Step 5: Run the full suite and type-check**

Run: `pnpm test && pnpm type-check`
Expected: PASS — all tests pass (existing + new), no type errors.

- [ ] **Step 6: Commit**

```bash
git add src/lib/sync/reconciliation.ts src/lib/sync/reconciliation.test.ts
git commit -m "feat: add relinkUnlinkedTransferPairs to backfill sourceGroupId onto pre-existing transfer pairs"
```

---

### Task 2: Wire `relinkUnlinkedTransferPairs` into the Staged Transactions "Scan" button

**Files:**
- Modify: `src/components/StagedTransactionsList.tsx`
- Test: `src/components/StagedTransactionsList.test.tsx`

**Interfaces:**
- Consumes: `relinkUnlinkedTransferPairs(api, inflowAccountIds, cashAccountIds): Promise<RelinkSummary>` from Task 1.
- Produces: nothing new for other tasks — this is the final consumer.

- [ ] **Step 1: Import `relinkUnlinkedTransferPairs` and add result-summary state**

In `src/components/StagedTransactionsList.tsx`, change the import line:

```ts
import { describeWithdrawals, findBackfillCandidates, resolveAmbiguous, runReconciliation } from '../lib/sync/reconciliation';
```

to:

```ts
import { describeWithdrawals, findBackfillCandidates, relinkUnlinkedTransferPairs, resolveAmbiguous, runReconciliation } from '../lib/sync/reconciliation';
```

Add a new state variable next to `const [scanning, setScanning] = useState(false);`:

```ts
  const [scanResult, setScanResult] = useState<string | null>(null);
```

- [ ] **Step 2: Extend `scanForOlderPayments` to also relink and report both counts**

Replace the current `scanForOlderPayments` function body:

```ts
  async function scanForOlderPayments() {
    setError(null);
    setScanning(true);
    try {
      const existing = await readStaging(api);
      const found = await findBackfillCandidates(api, cardAccountIds, paymentKeywords, cashAccountIds, transferKeywords, existing);
      const { candidates: remaining } = await runReconciliation(
        api,
        [...existing, ...found],
        cashAccountIds,
        Math.floor(Date.now() / 1000),
      );
      setCandidates(remaining);
      await writeStaging(api, remaining);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setScanning(false);
    }
  }
```

with:

```ts
  async function scanForOlderPayments() {
    setError(null);
    setScanResult(null);
    setScanning(true);
    try {
      const existing = await readStaging(api);
      const found = await findBackfillCandidates(api, cardAccountIds, paymentKeywords, cashAccountIds, transferKeywords, existing);
      const { candidates: remaining } = await runReconciliation(
        api,
        [...existing, ...found],
        cashAccountIds,
        Math.floor(Date.now() / 1000),
      );
      setCandidates(remaining);
      await writeStaging(api, remaining);

      const { relinked, ambiguous } = await relinkUnlinkedTransferPairs(api, [...cardAccountIds, ...cashAccountIds], cashAccountIds);
      setScanResult(
        `Found ${found.length} new candidate${found.length === 1 ? '' : 's'}. Relinked ${relinked} pair${relinked === 1 ? '' : 's'}, ${ambiguous} ambiguous.`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setScanning(false);
    }
  }
```

- [ ] **Step 3: Update the button label and render the result text**

Replace:

```ts
  const scanButton = (
    <Button size="sm" variant="outline" onClick={scanForOlderPayments} disabled={scanning}>
      {scanning ? 'Scanning…' : 'Scan for older payments and transfers'}
    </Button>
  );
```

with:

```ts
  const scanButton = (
    <div className="flex flex-col gap-1">
      <Button size="sm" variant="outline" onClick={scanForOlderPayments} disabled={scanning}>
        {scanning ? 'Scanning…' : 'Scan for older payments, transfers, and unlinked pairs'}
      </Button>
      {scanResult && <p className="text-muted-foreground text-sm">{scanResult}</p>}
    </div>
  );
```

- [ ] **Step 4: Add a test exercising the relink wiring**

Add this test to `src/components/StagedTransactionsList.test.tsx`, in the main `describe('StagedTransactionsList', ...)` block, near the other scan tests:

```ts
  it('relinks unlinked transfer pairs found during a scan and reports the count', async () => {
    const host = createMockHost();
    host.api.activities.search = vi.fn(async (_p: number, _s: number, filters: { activityTypes: string }) => {
      if (filters.activityTypes === 'TRANSFER_IN') {
        return {
          data: [
            {
              id: 'OLD-TIN-1',
              accountId: 'WF-CARD',
              activityType: 'TRANSFER_IN',
              date: '2025-08-06T00:00:00+00:00',
              amount: '50',
              currency: 'USD',
              comment: 'Old payment',
            },
          ],
          meta: { totalRowCount: 1 },
        };
      }
      if (filters.activityTypes === 'TRANSFER_OUT') {
        return {
          data: [
            {
              id: 'OLD-TOUT-1',
              accountId: 'WF-CASH',
              activityType: 'TRANSFER_OUT',
              date: '2025-08-05T00:00:00+00:00',
              amount: '50',
              currency: 'USD',
              comment: 'Old withdrawal',
            },
          ],
          meta: { totalRowCount: 1 },
        };
      }
      return { data: [], meta: { totalRowCount: 0 } };
    }) as never;

    render(<StagedTransactionsList api={host.api} {...defaultProps} />);
    await screen.findByText(/no staged transactions/i);

    await userEvent.click(screen.getByRole('button', { name: /scan for older payments/i }));

    expect(await screen.findByText(/relinked 1 pair/i)).toBeInTheDocument();
    expect(host.api.activities.saveMany).toHaveBeenCalledWith({
      creates: [
        expect.objectContaining({ accountId: 'WF-CARD', activityType: 'TRANSFER_IN', sourceGroupId: 'OLD-TIN-1' }),
        expect.objectContaining({ accountId: 'WF-CASH', activityType: 'TRANSFER_OUT', sourceGroupId: 'OLD-TIN-1' }),
      ],
      deleteIds: ['OLD-TIN-1', 'OLD-TOUT-1'],
    });
  });
```

- [ ] **Step 5: Verify the two existing scan tests still pass unchanged**

Run: `pnpm test -- StagedTransactionsList.test.tsx`

The two pre-existing tests named `'scans existing activities and stages a keyword match with no withdrawal pair yet'` and `'immediately resolves a scanned candidate when a matching withdrawal already exists'` should still pass without modification — their `search` mocks only branch on `filters.activityTypes === 'CREDIT'` vs. an else-branch, so the new `TRANSFER_IN`/`TRANSFER_OUT` searches this task adds fall into that else-branch. In the second test specifically, the else-branch happens to return a `WITHDRAWAL`-typed fixture on account `WF-CASH` regardless of the requested type — trace through `relinkUnlinkedTransferPairs`'s matching logic for that fixture value (`accountId: 'WF-CASH'`) against the target it would build from that same fixture treated as a `TRANSFER_IN` result (also `accountId: 'WF-CASH'`): the same-account exclusion in `withdrawalMatches` should exclude it from matching itself, producing zero matches and no extra `saveMany` call. Confirm this by reading the test output rather than assuming — if either test fails or produces an unexpected extra `saveMany` call, do not weaken assertions to force a pass; report BLOCKED with what you saw so the mock (or this plan) can be fixed with fresh eyes, since this is a coincidental interaction the plan predicted but did not want to weaken safety on.

Expected: PASS — all tests in this file pass, both pre-existing and the new one from Step 4.

- [ ] **Step 6: Run the full suite and type-check**

Run: `pnpm test && pnpm type-check`
Expected: PASS — everything green, no type errors.

- [ ] **Step 7: Commit**

```bash
git add src/components/StagedTransactionsList.tsx src/components/StagedTransactionsList.test.tsx
git commit -m "feat: wire relink into the Scan button and surface the result count"
```

---

### Task 3: Manual verification against the live e2e host

**Files:** none (verification only)

- [ ] **Step 1: Build and package**

Run: `pnpm bundle`
Expected: `dist/simplefin-wealthfolio-addon-1.0.0.zip` produced with no build errors.

- [ ] **Step 2: Install into `wealthfolio-e2e` (or hand the zip to the user)**

Same install flow as the prior plan's Task 3: Settings → Add-ons → "+" → "Install from File". If driving this via browser automation, expect the same sandboxed-iframe input limitation already documented in `docs/superpowers/plans/2026-08-26-sourcegroupid-transfer-linking.md`'s Task 3 — if clicks don't register inside the addon's own tab content, hand the zip to the user instead of attempting further automation workarounds.

- [ ] **Step 3: Click "Scan for older payments, transfers, and unlinked pairs" and confirm the result text**

Expected: the result line under the button shows a non-negative `relinked` count, and any of the 28 originally-flagged transfer pairs that had an unambiguous match no longer appear as incomplete in Wealthfolio's Data Consistency check.

- [ ] **Step 4: No commit** — this task is verification only, nothing to commit.
