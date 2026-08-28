# Link Reclassified Transfers via sourceGroupId Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `reclassifyPair()` link both legs of a reconciled transfer via `sourceGroupId` so Wealthfolio's Data Consistency checker stops flagging them as incomplete.

**Architecture:** `reclassifyPair()` (`src/lib/sync/reconciliation.ts`) currently reclassifies both legs in place via `activities.saveMany({ updates: [...] })`. A live-host probe confirmed `update()` silently drops `sourceGroupId` but `saveMany({ creates: [...] })` persists it. The fix switches `reclassifyPair()` to delete both original legs and recreate them as `TRANSFER_IN`/`TRANSFER_OUT` with `sourceGroupId` set to the candidate's `sfTransactionId`, in one `saveMany` call.

**Tech Stack:** TypeScript, Vitest, `@wealthfolio/addon-sdk` (`ActivityCreate`, `saveMany`).

**Spec:** `docs/superpowers/specs/2026-08-26-sourcegroupid-transfer-linking-design.md`

## Global Constraints

- No manifest change — `saveMany({ creates, deleteIds })` works under the already-declared `saveMany` permission (confirmed live); do not add `create` to `manifest.json`.
- `sourceGroupId` value is the candidate's existing `sfTransactionId` — do not generate a new id.
- Both legs must be created and deleted in a single `saveMany` call (same split-write rationale as the code being replaced).
- `resolveAmbiguous()` is not touched directly — it already delegates to `reclassifyPair()`.

---

### Task 1: Extend the mock host's `saveMany` to support `creates`/`deleteIds`

**Files:**
- Modify: `src/test/mockHost.ts:45-51`

**Interfaces:**
- Consumes: nothing new.
- Produces: `host.api.activities.saveMany` now echoes `req.creates` into `result.created` (each entry assigned a synthetic id) in addition to the existing `req.updates` → `result.updated` echo, and `req.deleteIds` into `result.deleted`. Task 2/3 rely on this to exercise the new `reclassifyPair()` without every test needing its own `saveMany` mock.

- [ ] **Step 1: Replace the `saveMany` mock**

Replace lines 45-51 of `src/test/mockHost.ts`:

```ts
      saveMany: vi.fn(async (req: { updates?: unknown[] }) => ({
        created: [],
        updated: req.updates ?? [],
        deleted: [],
        createdMappings: [],
        errors: [],
      })),
```

with:

```ts
      saveMany: vi.fn(async (req: { creates?: unknown[]; updates?: unknown[]; deleteIds?: string[] }) => ({
        created: (req.creates ?? []).map((c, i) => ({ id: `MOCK-CREATED-${i}`, ...(c as object) })),
        updated: req.updates ?? [],
        deleted: req.deleteIds ?? [],
        createdMappings: [],
        errors: [],
      })),
```

- [ ] **Step 2: Run the existing suite to confirm nothing broke**

Run: `pnpm test`
Expected: PASS — all 202 existing tests still pass (this step is purely additive; no test yet exercises `creates`/`deleteIds`).

- [ ] **Step 3: Commit**

```bash
git add src/test/mockHost.ts
git commit -m "test: mock host saveMany echoes creates/deleteIds"
```

---

### Task 2: Switch `reclassifyPair()` to delete+recreate with `sourceGroupId`

**Files:**
- Modify: `src/lib/sync/reconciliation.ts:1` (import), `src/lib/sync/reconciliation.ts:184-232` (`toUpdate`/`reclassifyPair`)
- Modify: `src/lib/sync/reconciliation.test.ts:66-71,104-109,632-637,666-671` (the four assertions on `saveMany`'s exact call shape)

**Interfaces:**
- Consumes: `StagedCandidate.sfTransactionId` (existing field, used as the new `sourceGroupId`).
- Produces: `reclassifyPair(api, inflowRow, withdrawalRow, sfTransactionId)` — same signature as before, same callers (`runReconciliation`, `resolveAmbiguous`), no changes needed at either call site.

- [ ] **Step 1: Update the four `saveMany` assertions to expect the new shape (failing first)**

In `src/lib/sync/reconciliation.test.ts`, replace each of the four occurrences of this pattern (lines 66-71 and 104-109 in the `runReconciliation` describe block, and lines 632-637 and 666-671 in the `resolveAmbiguous` describe block):

Occurrence 1 (`'resolves a unique match by reclassifying both legs'`, currently lines 66-71):

```ts
    expect(host.api.activities.saveMany).toHaveBeenCalledWith({
      updates: [
        expect.objectContaining({ id: 'CARD-ACT-1', activityType: 'TRANSFER_IN' }),
        expect.objectContaining({ id: 'CASH-ACT-1', activityType: 'TRANSFER_OUT' }),
      ],
    });
```

becomes:

```ts
    expect(host.api.activities.saveMany).toHaveBeenCalledWith({
      creates: [
        expect.objectContaining({ accountId: 'WF-CARD', activityType: 'TRANSFER_IN', sourceGroupId: 'TXN-1' }),
        expect.objectContaining({ accountId: 'WF-CASH', activityType: 'TRANSFER_OUT', sourceGroupId: 'TXN-1' }),
      ],
      deleteIds: ['CARD-ACT-1', 'CASH-ACT-1'],
    });
```

Occurrence 2 (`'resolves a cash-to-cash transfer candidate (DEPOSIT inflow) the same way'`, currently lines 104-109):

```ts
    expect(host.api.activities.saveMany).toHaveBeenCalledWith({
      updates: [
        expect.objectContaining({ id: 'DEPOSIT-ACT-1', activityType: 'TRANSFER_IN' }),
        expect.objectContaining({ id: 'CASH-ACT-1', activityType: 'TRANSFER_OUT' }),
      ],
    });
```

becomes:

```ts
    expect(host.api.activities.saveMany).toHaveBeenCalledWith({
      creates: [
        expect.objectContaining({ accountId: 'WF-CASH-B', activityType: 'TRANSFER_IN', sourceGroupId: 'TXN-1' }),
        expect.objectContaining({ accountId: 'WF-CASH-A', activityType: 'TRANSFER_OUT', sourceGroupId: 'TXN-1' }),
      ],
      deleteIds: ['DEPOSIT-ACT-1', 'CASH-ACT-1'],
    });
```

Occurrence 3 (in `describe('resolveAmbiguous', ...)`, `'reclassifies the chosen withdrawal and the resolved inflow activity'`, currently lines 632-637):

```ts
    expect(host.api.activities.saveMany).toHaveBeenCalledWith({
      updates: [
        expect.objectContaining({ id: 'CARD-ACT-1', activityType: 'TRANSFER_IN' }),
        expect.objectContaining({ id: 'CASH-ACT-1', activityType: 'TRANSFER_OUT' }),
      ],
    });
```

becomes:

```ts
    expect(host.api.activities.saveMany).toHaveBeenCalledWith({
      creates: [
        expect.objectContaining({ accountId: 'WF-CARD', activityType: 'TRANSFER_IN', sourceGroupId: 'TXN-1' }),
        expect.objectContaining({ accountId: 'WF-CASH', activityType: 'TRANSFER_OUT', sourceGroupId: 'TXN-1' }),
      ],
      deleteIds: ['CARD-ACT-1', 'CASH-ACT-1'],
    });
```

Occurrence 4 (`'reclassifies the chosen withdrawal and the resolved deposit activity for a cash-transfer candidate'`, currently lines 666-671):

```ts
    expect(host.api.activities.saveMany).toHaveBeenCalledWith({
      updates: [
        expect.objectContaining({ id: 'DEPOSIT-ACT-1', activityType: 'TRANSFER_IN' }),
        expect.objectContaining({ id: 'CASH-ACT-1', activityType: 'TRANSFER_OUT' }),
      ],
    });
```

becomes:

```ts
    expect(host.api.activities.saveMany).toHaveBeenCalledWith({
      creates: [
        expect.objectContaining({ accountId: 'WF-CASH-B', activityType: 'TRANSFER_IN', sourceGroupId: 'TXN-1' }),
        expect.objectContaining({ accountId: 'WF-CASH', activityType: 'TRANSFER_OUT', sourceGroupId: 'TXN-1' }),
      ],
      deleteIds: ['DEPOSIT-ACT-1', 'CASH-ACT-1'],
    });
```

- [ ] **Step 2: Run the suite to confirm these four tests now fail**

Run: `pnpm test -- reconciliation.test.ts`
Expected: FAIL — exactly these 4 tests fail, each showing `saveMany` was called with `{ updates: [...] }` (old shape) instead of the expected `{ creates: [...], deleteIds: [...] }`. All other tests in the file still pass.

- [ ] **Step 3: Update the import**

In `src/lib/sync/reconciliation.ts`, line 1, replace:

```ts
import type { ActivityDetails, ActivityUpdate, HostAPI } from '@wealthfolio/addon-sdk';
```

with:

```ts
import type { ActivityCreate, ActivityDetails, HostAPI } from '@wealthfolio/addon-sdk';
```

- [ ] **Step 4: Replace `toUpdate`/`reclassifyPair` with `toCreate`/`reclassifyPair`**

In `src/lib/sync/reconciliation.ts`, replace lines 184-232 (the `toUpdate` function, its preceding blank line, the `reclassifyPair` doc comment, and the `reclassifyPair` function):

```ts
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
 * sequential `update()` calls: `findInflowActivity()` only ever searches
 * `candidate.inflowActivityType`, so if the inflow leg alone were
 * reclassified to `TRANSFER_IN` and the withdrawal leg's write then failed,
 * the next reconciliation attempt could never re-find the (now
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
 */
async function reclassifyPair(
  api: HostAPI,
  inflowRow: ActivityDetails,
  withdrawalRow: ActivityDetails,
  sfTransactionId: string,
): Promise<void> {
  const result = await api.activities.saveMany({
    updates: [toUpdate(inflowRow, 'TRANSFER_IN'), toUpdate(withdrawalRow, 'TRANSFER_OUT')],
  });
  if (result.errors.length > 0) {
    throw new Error(
      `saveMany reported per-item errors for candidate ${sfTransactionId}: ${JSON.stringify(result.errors)}`,
    );
  }
}
```

with:

```ts
function toCreate(row: ActivityDetails, activityType: string, sourceGroupId: string): ActivityCreate {
  return {
    accountId: row.accountId,
    activityType,
    activityDate: row.date,
    amount: row.amount,
    currency: row.currency,
    comment: row.comment,
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
```

- [ ] **Step 5: Run the full suite and type-check**

Run: `pnpm test && pnpm type-check`
Expected: PASS — all tests pass, including the 4 updated in Step 1; no type errors.

- [ ] **Step 6: Commit**

```bash
git add src/lib/sync/reconciliation.ts src/lib/sync/reconciliation.test.ts
git commit -m "fix: link reclassified transfer legs via sourceGroupId instead of update()"
```

---

### Task 3: Manual verification against the live e2e host

**Files:** none (verification only)

- [ ] **Step 1: Build and package**

Run: `pnpm bundle`
Expected: `dist/simplefin-wealthfolio-addon-1.0.0.zip` produced with no build errors.

- [ ] **Step 2: Install into the `wealthfolio-e2e` container**

Reuse the flow from this investigation: on `http://localhost:8088/settings/addons`, click the "+" button → "Install from File" → upload `dist/simplefin-wealthfolio-addon-1.0.0.zip` → "Approve & Install". This replaces the currently-installed build; existing config/mappings persist (same addon id).

Note: interacting with the addon's own sandboxed iframe content (its tabs, "Sync now" button) was unreachable via this session's browser-automation tooling — clicks and keyboard input did not register anywhere inside it, across repeated attempts. The Addon Manager page itself (outside the iframe) was unaffected. If this is still the case, trigger "Sync now" from inside the actual Wealthfolio window directly (mouse/keyboard on the real display) rather than through automation, or ask the user to click it.

- [ ] **Step 3: Run a sync and confirm a transfer gets linked**

Trigger "Sync now" on a mapping that has at least one pending card-payment or cash-transfer candidate ready to resolve (check the "Staged" tab first). After it resolves, check `http://localhost:8088/health` (or wherever the Data Consistency checker surfaces) and confirm the newly-reclassified pair is no longer flagged as an incomplete transfer.

Expected: the reclassified pair does not appear in the incomplete-transfers list. (The 28 pairs already flagged before this fix existed were reclassified under the old `update()` path and remain unlinked — this step is about confirming *new* reclassifications are linked, not retroactively fixing the existing 28.)

- [ ] **Step 4: No commit** — this task is verification only, nothing to commit.
