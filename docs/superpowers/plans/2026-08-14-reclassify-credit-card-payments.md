# Reclassify Credit-Card Payments as TRANSFER_IN/TRANSFER_OUT Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect credit-card bill payments, stage them across sync runs, match each to its paying cash-account withdrawal, and reclassify both legs from `CREDIT`/`WITHDRAWAL` to `TRANSFER_IN`/`TRANSFER_OUT` — fixing a pre-existing bug (the host rejects `DEPOSIT` on credit-card accounts) along the way.

**Architecture:** A per-transaction detection step inside the existing cash-sync path stages keyword-matched card credits; a separate reconciliation pass (new module, invoked once per `runSync`) matches staged candidates against withdrawal activities host-side via `activities.search()` and reclassifies unique matches via `activities.update()`. Staging persists in its own `storage` key so partial matches survive across runs. A new Sync-page tab surfaces unresolved candidates for manual resolution.

**Tech Stack:** TypeScript, React, Vitest, `@wealthfolio/addon-sdk` `HostAPI`.

**Spec:** `docs/superpowers/specs/2026-08-14-reclassify-credit-card-payments-design.md`

## Global Constraints

- No hardcoded numeric values beyond named, commented constants tied to an explicit requirement (matches this repo's existing `OVERLAP_DAYS`/`HISTORY_LIMIT`/`RECENT_ID_WINDOW` precedent) — never a fabricated score or threshold.
- Never parse money amounts to `Number`/`float` for comparison or arithmetic — use `normalise()` (string-based) for equality, matching this repo's existing convention.
- Every caught error is logged via `api.logger.error` with account/candidate context, or re-thrown — never swallowed silently.
- `activities.search()` pages from `0`, not `1`.
- `activities.update()`'s payload must echo the full existing row (`id`, `accountId`, `activityType`, `activityDate`, `amount`, `currency`, `comment`) — omitted fields risk being nulled by the host.
- `manifest.json`'s `activities` permission needs `search` and `update` added — not `getAll` or `saveMany`, which nothing in this feature calls.
- Per-candidate and per-account failures are isolated: one bad match/API error must not block any other candidate or account.

---

## File Structure

**New files:**
- `src/lib/storage/staging.ts` — `StagedCandidate` type + `readStaging`/`writeStaging`, same one-value-is-the-whole-list shape as `history.ts`.
- `src/lib/storage/staging.test.ts`
- `src/lib/sync/reconciliation.ts` — cross-run matching, reclassification, expiry, and the manual-resolution entry point the UI calls.
- `src/lib/sync/reconciliation.test.ts`
- `src/components/StagedTransactionsList.tsx` — the new "Staged" tab's content.
- `src/components/StagedTransactionsList.test.tsx`

**Modified files:**
- `src/lib/storage/config.ts` — add `paymentKeywords: string[]` + `DEFAULT_PAYMENT_KEYWORDS`.
- `src/lib/storage/config.test.ts` — update existing shape assertions, add keyword-default coverage.
- `src/lib/sync/balance.ts` — export `normalise` (currently private) for reuse in `reconciliation.ts`.
- `src/lib/sync/activities.ts` — export `isoDate`; `toActivityImport` takes the destination account's `AccountType` and emits `CREDIT` instead of `DEPOSIT` for `CREDIT_CARD` accounts; add `isPaymentCandidate`/`detectCandidate`; `syncCashAccount` gains `accountType`/`paymentKeywords` params and returns detected `candidates`.
- `src/lib/sync/activities.test.ts` — update every `toActivityImport`/`syncCashAccount` call site for the new params; add CREDIT-emission and detection tests.
- `src/lib/sync/run.ts` — build a `wfAccountId -> AccountType` map alongside the existing balance map; thread it and `config.paymentKeywords` through `syncOne`; after the per-account loop, merge newly detected candidates with existing staging, run reconciliation, persist the result.
- `src/lib/sync/run.test.ts` — update `syncOne`/`syncCashAccount` call sites; add reconciliation-wiring tests.
- `src/components/SettingsPanel.tsx` — add a keyword-list editor following the `lookbackDays` draft-input-plus-Save pattern.
- `src/components/SettingsPanel.test.tsx` — new tests for the keyword editor.
- `src/pages/SyncPage.tsx` — add a "Staged" tab rendering `StagedTransactionsList`.
- `src/pages/SyncPage.sync.test.tsx` — add coverage for the new tab appearing and reading staged candidates.
- `src/test/mockHost.ts` — add `activities.search`/`activities.update` mocks (currently only `checkImport`/`import` exist).
- `manifest.json` — declare `search` and `update` under the `activities` permission.

---

### Task 1: Config — configurable payment keywords

**Files:**
- Modify: `src/lib/storage/config.ts`
- Modify: `src/lib/sync/run.test.ts` (two pre-existing typed `SyncConfig` fixtures need the new required field — see Step 3b)
- Test: `src/lib/storage/config.test.ts`

**Interfaces:**
- Produces: `SyncConfig.paymentKeywords: string[]`; `DEFAULT_PAYMENT_KEYWORDS: readonly string[]` exported from `src/lib/storage/config.ts`.

**Pre-flight note:** `paymentKeywords` is a *required* field on `SyncConfig`.
Two typed `SyncConfig` object literals already exist outside `config.ts` —
`src/lib/sync/run.test.ts`'s top-level `config` (used by `okHost()` and most
`describe('runSync', ...)` tests) and its `backfillConfig` (used by
`describe('runSync opening-balance backfill', ...)`) — and neither is
otherwise touched by this task's own tests. Without Step 3b below, this
task would leave `pnpm type-check` broken for every later task to trip
over. This is confirmed via `grep -rn "SyncConfig\s*=\s*{" src/` — those are
the only two typed literals in the codebase besides `config.ts` itself.

- [ ] **Step 1: Write the failing tests**

Update `src/lib/storage/config.test.ts` — every existing object literal that
asserts the full `SyncConfig` shape needs `paymentKeywords` added, and two
new tests cover the default and its backward-compat behavior:

```ts
import { describe, expect, it } from 'vitest';
import { createMockHost } from '../../test/mockHost';
import { DEFAULT_LOOKBACK_DAYS, DEFAULT_PAYMENT_KEYWORDS, readConfig, writeConfig } from './config';

describe('config', () => {
  it('returns an empty config when nothing is stored', async () => {
    const host = createMockHost();
    expect(await readConfig(host.api)).toEqual({
      baseUrl: null,
      mappings: [],
      lookbackDays: DEFAULT_LOOKBACK_DAYS,
      paymentKeywords: DEFAULT_PAYMENT_KEYWORDS,
    });
  });

  it('round-trips a config', async () => {
    const host = createMockHost();
    const config = {
      baseUrl: 'https://bridge.simplefin.org/simplefin',
      mappings: [
        {
          sfAccountId: 'ACT-1',
          wfAccountId: 'WF-1',
          mode: 'CASH' as const,
          sfAccountName: 'Checking',
          orgName: 'Test Bank',
        },
      ],
      lookbackDays: 60,
      paymentKeywords: ['PAYMENT', 'AUTOPAY'],
    };
    await writeConfig(host.api, config);
    expect(await readConfig(host.api)).toEqual(config);
  });

  it('defaults lookbackDays and paymentKeywords for a config written before those fields existed', async () => {
    const host = createMockHost();
    await host.api.storage.set(
      'simplefin.config',
      JSON.stringify({ baseUrl: 'https://bridge.simplefin.org/simplefin', mappings: [] }),
    );
    expect(await readConfig(host.api)).toEqual({
      baseUrl: 'https://bridge.simplefin.org/simplefin',
      mappings: [],
      lookbackDays: DEFAULT_LOOKBACK_DAYS,
      paymentKeywords: DEFAULT_PAYMENT_KEYWORDS,
    });
  });

  it('never stores credentials in the base URL', async () => {
    const host = createMockHost();
    await writeConfig(host.api, {
      baseUrl: 'https://bridge.simplefin.org/simplefin',
      mappings: [],
      lookbackDays: DEFAULT_LOOKBACK_DAYS,
      paymentKeywords: DEFAULT_PAYMENT_KEYWORDS,
    });
    const stored = [...host.storage.values()].join('');
    expect(stored).not.toContain('@');
  });

  it('recovers from a corrupt config rather than throwing', async () => {
    const host = createMockHost();
    await host.api.storage.set('simplefin.config', '{not json');
    expect(await readConfig(host.api)).toEqual({
      baseUrl: null,
      mappings: [],
      lookbackDays: DEFAULT_LOOKBACK_DAYS,
      paymentKeywords: DEFAULT_PAYMENT_KEYWORDS,
    });
    expect(host.api.logger.error).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test -- config.test.ts`
Expected: FAIL — `DEFAULT_PAYMENT_KEYWORDS` is not exported, and the shape
assertions are missing `paymentKeywords` from the actual `emptyConfig()`.

- [ ] **Step 3: Implement**

In `src/lib/storage/config.ts`, add the field and default, and include it in
`emptyConfig()`:

```ts
export interface SyncConfig {
  /** Credential-free SimpleFIN base URL. Credentials live in `secrets`. */
  baseUrl: string | null;
  mappings: AccountMapping[];
  /** Floor on how far back a sync ever asks the Bridge for, in days. */
  lookbackDays: number;
  /** Case-insensitive substrings checked against a card credit's payee/comment to detect a bill payment. */
  paymentKeywords: string[];
}

/** One statement cycle — enough to seed a new account without an unbounded first pull. */
export const DEFAULT_LOOKBACK_DAYS = 30;

/** Common bill-payment phrasing across US/Canadian card issuers. */
export const DEFAULT_PAYMENT_KEYWORDS = ['PAYMENT', 'AUTOPAY', 'THANK YOU'];

const CONFIG_KEY = storageKey('config');

export function emptyConfig(): SyncConfig {
  return {
    baseUrl: null,
    mappings: [],
    lookbackDays: DEFAULT_LOOKBACK_DAYS,
    paymentKeywords: DEFAULT_PAYMENT_KEYWORDS,
  };
}
```

`readConfig()`'s existing `{ ...emptyConfig(), ...parsed }` spread already
backfills `paymentKeywords` for configs written before this field existed —
no change needed there.

- [ ] **Step 3b: Fix the two pre-existing typed `SyncConfig` fixtures**

In `src/lib/sync/run.test.ts`, add `paymentKeywords: ['PAYMENT', 'AUTOPAY', 'THANK YOU']`
to both the top-level `config` object (used by `okHost()` and the main
`describe('runSync', ...)` tests) and to `backfillConfig` inside
`describe('runSync opening-balance backfill', ...)`. Neither test in that
file asserts on `paymentKeywords` — this step exists purely so the file
still type-checks, not to add new behavior.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm type-check && pnpm test -- config.test.ts run.test.ts`
Expected: PASS — the `type-check` here specifically confirms Step 3b closed
the gap; a green `config.test.ts` alone would not have caught it.

- [ ] **Step 5: Commit**

```bash
git add src/lib/storage/config.ts src/lib/storage/config.test.ts src/lib/sync/run.test.ts
git commit -m "feat: add configurable payment keywords to SyncConfig"
```

---

### Task 2: Storage — staging store

**Files:**
- Create: `src/lib/storage/staging.ts`
- Test: `src/lib/storage/staging.test.ts`

**Interfaces:**
- Produces: `StagedCandidate` type, `readStaging(api): Promise<StagedCandidate[]>`, `writeStaging(api, candidates): Promise<void>`, all from `src/lib/storage/staging.ts`.

- [ ] **Step 1: Write the failing tests**

```ts
// src/lib/storage/staging.test.ts
import { describe, expect, it } from 'vitest';
import { createMockHost } from '../../test/mockHost';
import { readStaging, writeStaging, type StagedCandidate } from './staging';

const candidate = (over: Partial<StagedCandidate> = {}): StagedCandidate => ({
  sfTransactionId: 'TXN-1',
  cardAccountId: 'WF-CARD',
  cardActivityId: null,
  amount: '50.00',
  postedDate: '2026-08-01',
  comment: 'ONLINE PAYMENT THANK YOU',
  status: 'pending',
  candidateWithdrawalIds: [],
  ...over,
});

describe('staging', () => {
  it('returns an empty list when nothing is stored', async () => {
    const host = createMockHost();
    expect(await readStaging(host.api)).toEqual([]);
  });

  it('round-trips the staged candidate list', async () => {
    const host = createMockHost();
    const candidates = [candidate(), candidate({ sfTransactionId: 'TXN-2', status: 'ambiguous', candidateWithdrawalIds: ['A-1', 'A-2'] })];
    await writeStaging(host.api, candidates);
    expect(await readStaging(host.api)).toEqual(candidates);
  });

  it('recovers from a corrupt store rather than throwing', async () => {
    const host = createMockHost();
    await host.api.storage.set('simplefin.staging', '{not json');
    expect(await readStaging(host.api)).toEqual([]);
    expect(host.api.logger.error).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test -- staging.test.ts`
Expected: FAIL — `./staging` does not exist.

- [ ] **Step 3: Implement**

```ts
// src/lib/storage/staging.ts
import type { HostAPI } from '@wealthfolio/addon-sdk';
import { storageKey } from './keys';

export type CandidateStatus = 'pending' | 'ambiguous';

export interface StagedCandidate {
  /** Identity: the SimpleFIN transaction id of the card-side CREDIT. */
  sfTransactionId: string;
  /** Wealthfolio account id of the credit-card account. */
  cardAccountId: string;
  /** Real Wealthfolio activity id — null until a reconciliation pass resolves it via search(). */
  cardActivityId: string | null;
  amount: string;
  /** ISO date (YYYY-MM-DD) the card CREDIT posted. */
  postedDate: string;
  comment: string;
  status: CandidateStatus;
  /** Populated once status is 'ambiguous'; the real Wealthfolio activity ids of the competing withdrawals. */
  candidateWithdrawalIds: string[];
}

const STAGING_KEY = storageKey('staging');

export async function readStaging(api: HostAPI): Promise<StagedCandidate[]> {
  const raw = await api.storage.get(STAGING_KEY);
  if (!raw) return [];

  try {
    return JSON.parse(raw) as StagedCandidate[];
  } catch (error) {
    api.logger.error(`[simplefin] corrupt staging store, starting fresh: ${String(error)}`);
    return [];
  }
}

export async function writeStaging(api: HostAPI, candidates: StagedCandidate[]): Promise<void> {
  await api.storage.set(STAGING_KEY, JSON.stringify(candidates));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test -- staging.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/storage/staging.ts src/lib/storage/staging.test.ts
git commit -m "feat: add staging store for credit-card payment reconciliation candidates"
```

---

### Task 3: Fix — emit `CREDIT` instead of `DEPOSIT` for credit-card accounts

**Files:**
- Modify: `src/lib/sync/activities.ts`
- Modify: `src/lib/sync/run.ts`
- Test: `src/lib/sync/activities.test.ts`
- Test: `src/lib/sync/run.test.ts`

**Interfaces:**
- Consumes: `AccountType` from `@wealthfolio/addon-sdk` (`Account.accountType`'s type — `'SECURITIES' | 'CASH' | 'CREDIT_CARD' | 'CRYPTOCURRENCY'`).
- Produces: `toActivityImport(txn, mapping, currency, destinationAccountType)` — 4th required param. `isoDate` now exported. `syncCashAccount`'s signature gains a required `accountType: AccountType` 5th param (6th param `paymentKeywords: string[]` added in Task 4, but declared here as an empty-array-accepting param so this task's call sites don't need touching twice — see Step 3 for the exact signature this task lands).

- [ ] **Step 1: Write the failing tests**

Replace the entire contents of `src/lib/sync/activities.test.ts` with the
version below — every existing `toActivityImport` call needs the new 4th
argument and every existing `syncCashAccount` call needs the new 5th/6th
arguments, so nearly every test line changes:

```ts
import { describe, expect, it, vi } from 'vitest';
import type { ActivityImport } from '@wealthfolio/addon-sdk';
import { createMockHost } from '../../test/mockHost';
import type { AccountMapping } from '../storage/config';
import { emptyWatermark } from '../storage/watermark';
import { syncCashAccount, toActivityImport } from './activities';

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

    await syncCashAccount(host.api, mapping, account([txn()]) as never, emptyWatermark(), 'CASH', []);
    expect(order).toEqual(['check', 'import']);
  });

  it('does not import rows the host flagged as duplicates', async () => {
    const host = createMockHost();
    host.api.activities.checkImport = vi.fn(async (a: ActivityImport[]) =>
      a.map((row) => ({ ...row, duplicateOfId: 'EXISTING', isValid: true })),
    );
    host.api.activities.import = vi.fn();

    const { result } = await syncCashAccount(host.api, mapping, account([txn()]) as never, emptyWatermark(), 'CASH', []);

    expect(host.api.activities.import).not.toHaveBeenCalled();
    expect(result.duplicates).toBe(1);
  });

  it('does not import rows checkImport marked invalid', async () => {
    const host = createMockHost();
    host.api.activities.checkImport = vi.fn(async (a: ActivityImport[]) =>
      a.map((row) => ({ ...row, isValid: false, errors: { amount: ['bad'] } })),
    );
    host.api.activities.import = vi.fn();

    const { result } = await syncCashAccount(host.api, mapping, account([txn()]) as never, emptyWatermark(), 'CASH', []);

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

    const { watermark } = await syncCashAccount(host.api, mapping, account([txn()]) as never, emptyWatermark(), 'CASH', []);

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
      syncCashAccount(host.api, mapping, account([txn()]) as never, emptyWatermark(), 'CASH', []),
    ).rejects.toThrow(/host exploded/);
  });

  it('logs the rejected payload when checkImport itself throws, so the failing row is visible', async () => {
    const host = createMockHost();
    host.api.activities.checkImport = vi.fn(async () => {
      throw new Error('Unprocessable Entity');
    });

    await expect(
      syncCashAccount(host.api, mapping, account([txn()]) as never, emptyWatermark(), 'CASH', []),
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
      syncCashAccount(host.api, mapping, account([txn()]) as never, emptyWatermark(), 'CASH', []),
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
    );

    expect(importedRows[0].activityType).toBe('CREDIT');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test -- activities.test.ts`
Expected: FAIL — `toActivityImport`/`syncCashAccount` don't yet accept the
new params, and there is no `CREDIT`-emission behavior yet.

- [ ] **Step 3: Implement**

In `src/lib/sync/activities.ts`:

```ts
import type { AccountType, ActivityImport, HostAPI } from '@wealthfolio/addon-sdk';
import type { SfAccount, SfTransaction } from '../simplefin/parse';
import type { AccountMapping } from '../storage/config';
import { advanceWatermark, shouldPush, type Watermark } from '../storage/watermark';

/** Epoch seconds -> YYYY-MM-DD in UTC, the form Wealthfolio's importer expects. */
export function isoDate(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toISOString().slice(0, 10);
}

/**
 * SimpleFIN signs amounts (negative = money out); Wealthfolio splits direction
 * into the activity type and expects a positive magnitude. The string is kept
 * as a string throughout — parsing to a float would round real money.
 */
export function toActivityImport(
  txn: SfTransaction,
  mapping: AccountMapping,
  currency: string,
  destinationAccountType: AccountType,
): ActivityImport {
  const isOutflow = txn.amount.trim().startsWith('-');
  const magnitude = txn.amount.trim().replace(/^-/, '');
  // The host rejects DEPOSIT outright on a CREDIT_CARD account
  // ("DEPOSIT activities are not supported for credit card accounts",
  // confirmed against a live host) — CREDIT is the type it accepts for
  // money landing on a card.
  const inflowType = destinationAccountType === 'CREDIT_CARD' ? 'CREDIT' : 'DEPOSIT';

  return {
    accountId: mapping.wfAccountId,
    activityType: isOutflow ? 'WITHDRAWAL' : inflowType,
    date: isoDate(txn.posted),
    amount: magnitude,
    currency,
    // Cash activities have no ticker. The addon-sdk types this as optional,
    // but the host's import endpoint deserializes it as a required field and
    // rejects the whole batch with an instant 422 if it's absent — confirmed
    // against a live host (SDK 3.6.2 vs host 3.6.3 version skew).
    symbol: '',
    comment: txn.payee || txn.description,
    isValid: true,
    isDraft: false,
  };
}

export interface CashSyncCounts {
  imported: number;
  skipped: number;
  duplicates: number;
}

export async function syncCashAccount(
  api: HostAPI,
  mapping: AccountMapping,
  sfAccount: SfAccount,
  watermark: Watermark,
  accountType: AccountType,
  paymentKeywords: string[],
): Promise<{ result: CashSyncCounts; watermark: Watermark; candidates: never[] }> {
  // Pending transactions are excluded from v1: their id and amount can both
  // change once posted, which would push a row we could never reconcile.
  const candidates = sfAccount.transactions.filter((t) => !t.pending && shouldPush(watermark, t));

  if (candidates.length === 0) {
    return { result: { imported: 0, skipped: 0, duplicates: 0 }, watermark, candidates: [] };
  }

  const rows = candidates.map((t) => toActivityImport(t, mapping, sfAccount.currency, accountType));
  let checked;
  try {
    checked = await api.activities.checkImport(rows);
  } catch (error) {
    api.logger.error(
      `[simplefin] activities.checkImport rejected ${rows.length} row(s) for ` +
        `${mapping.sfAccountName}: ${JSON.stringify(rows)}`,
    );
    throw error;
  }

  const importable: ActivityImport[] = [];
  const importableTxns: SfTransaction[] = [];
  let duplicates = 0;
  let skipped = 0;

  checked.forEach((row, index) => {
    if (row.duplicateOfId || row.duplicateOfLineNumber !== undefined) {
      duplicates += 1;
      return;
    }
    if (!row.isValid) {
      skipped += 1;
      api.logger.error(
        `[simplefin] row rejected by checkImport for ${mapping.sfAccountName}: ` +
          JSON.stringify(row.errors ?? {}),
      );
      return;
    }
    importable.push(row);
    importableTxns.push(candidates[index]);
  });

  if (importable.length === 0) {
    const advanced = advanceWatermark(
      watermark,
      candidates.filter((_, i) => checked[i].duplicateOfId),
    );
    return { result: { imported: 0, skipped, duplicates }, watermark: advanced, candidates: [] };
  }

  let outcome;
  try {
    outcome = await api.activities.import(importable);
  } catch (error) {
    api.logger.error(
      `[simplefin] activities.import rejected ${importable.length} row(s) for ` +
        `${mapping.sfAccountName}: ${JSON.stringify(importable)}`,
    );
    throw error;
  }

  return {
    result: { imported: outcome.summary.imported, skipped, duplicates },
    watermark: advanceWatermark(watermark, importableTxns),
    candidates: [],
  };
}
```

(`candidates` is deliberately typed `never[]`/always `[]` here — Task 4 turns
it into real detection output. Landing the plumbing now keeps this task's
diff focused on the CREDIT-vs-DEPOSIT fix and its own review.)

In `src/lib/sync/run.ts`, thread `accountType` through. First, extend the
Wealthfolio-balances lookup loop to also collect account types (same
`api.accounts.getAll()` call, no extra request):

```ts
  const wfBalances = new Map<string, string>();
  const wfAccountTypes = new Map<string, AccountType>();
  try {
    for (const account of await api.accounts.getAll()) {
      if (Number.isFinite(account.balance)) wfBalances.set(account.id, String(account.balance));
      wfAccountTypes.set(account.id, account.accountType);
    }
  } catch (error) {
    api.logger.error(
      `[simplefin] could not read Wealthfolio balances for the mismatch check: ${String(error)}`,
    );
  }
```

Add the `AccountType` import at the top of `run.ts`:

```ts
import type { AccountType, HostAPI } from '@wealthfolio/addon-sdk';
```

Update `syncOne`'s signature and its `syncCashAccount` call:

```ts
async function syncOne(
  api: HostAPI,
  baseUrl: string,
  mapping: AccountMapping,
  sfAccount: SfAccount | undefined,
  wfBalances: Map<string, string>,
  wfAccountTypes: Map<string, AccountType>,
): Promise<AccountRunResult> {
  // ... unchanged up through reading the watermark ...

    const { result, watermark: next } = await syncCashAccount(
      api,
      mapping,
      syncSfAccount,
      watermark,
      wfAccountTypes.get(mapping.wfAccountId) ?? 'CASH',
      [],
    );
```

(The `[]` for `paymentKeywords` here is the same "plumbing now, wired for
real in Task 4" approach — Task 4 replaces it with `config.paymentKeywords`
threaded down from `runSync`.)

Update the call site in `runSync`:

```ts
  const results: AccountRunResult[] = [];
  for (const mapping of config.mappings) {
    results.push(
      await syncOne(api, config.baseUrl, mapping, bySfId.get(mapping.sfAccountId), wfBalances, wfAccountTypes),
    );
  }
```

Update `src/lib/sync/run.test.ts`'s `backfillHost` helper, which asserts on
`activityType` for pushed rows — it already handles `TRANSFER_OUT` but its
mock `checkImport`/`import` don't need changes since they operate on
whatever `activityType` `toActivityImport` produces; no call-site changes
needed there since `runSync`/`syncOne` (not the test) call `syncCashAccount`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test -- activities.test.ts run.test.ts`
Expected: PASS

- [ ] **Step 5: Run the full suite and type-check**

Run: `pnpm type-check && pnpm test`
Expected: PASS — this confirms no other file still calls the old
`toActivityImport`/`syncCashAccount` signatures.

- [ ] **Step 6: Commit**

```bash
git add src/lib/sync/activities.ts src/lib/sync/activities.test.ts src/lib/sync/run.ts src/lib/sync/run.test.ts
git commit -m "fix: emit CREDIT instead of DEPOSIT for money landing on a credit-card account

The host rejects DEPOSIT outright on CREDIT_CARD accounts, so every real
credit-card payment or credit was silently skipped on every sync. Confirmed
against a live host that CREDIT is accepted."
```

---

### Task 4: Detection — stage keyword-matched card credits

**Files:**
- Modify: `src/lib/sync/activities.ts`
- Modify: `src/lib/sync/run.ts`
- Test: `src/lib/sync/activities.test.ts`
- Test: `src/lib/sync/run.test.ts`

**Interfaces:**
- Consumes: `StagedCandidate` from `../storage/staging` (Task 2); `AccountType` from `@wealthfolio/addon-sdk`.
- Produces: `isPaymentCandidate(text, keywords): boolean` and `detectCandidate(txn, mapping, paymentKeywords): StagedCandidate | null`, both exported from `src/lib/sync/activities.ts`. `syncCashAccount`'s `candidates` return value is now real (`StagedCandidate[]`), and its `paymentKeywords` param actually does something. `syncOne` returns `{ accountResult: AccountRunResult; candidates: StagedCandidate[] }` instead of a bare `AccountRunResult`. `runSync` threads `config.paymentKeywords` through and collects all detected candidates (not yet persisted — that's Task 6).

- [ ] **Step 1: Write the failing tests**

Add to `src/lib/sync/activities.test.ts`:

```ts
import { detectCandidate, isPaymentCandidate, syncCashAccount, toActivityImport } from './activities';

// ... (existing imports/fixtures unchanged) ...

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
  it('stages a keyword-matched transaction with cardActivityId unresolved', () => {
    const candidate = detectCandidate(
      txn({ id: 'TXN-9', amount: '75.00', payee: 'Online Payment Thank You', posted: 1754438400 }) as never,
      mapping,
      ['PAYMENT'],
    );
    expect(candidate).toEqual({
      sfTransactionId: 'TXN-9',
      cardAccountId: 'WF-1',
      cardActivityId: null,
      amount: '75.00',
      postedDate: '2025-08-06',
      comment: 'Online Payment Thank You',
      status: 'pending',
      candidateWithdrawalIds: [],
    });
  });

  it('returns null for a transaction that does not match any keyword', () => {
    expect(detectCandidate(txn({ payee: 'Amazon Refund' }) as never, mapping, ['PAYMENT'])).toBeNull();
  });
});

// Add inside the existing `describe('syncCashAccount', ...)` block:
  it('stages a keyword-matched inflow on a credit-card account as a candidate', async () => {
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
    );

    expect(candidates).toHaveLength(1);
    expect(candidates[0].sfTransactionId).toBe('TXN-1');
  });

  it('does not stage a non-matching inflow, an outflow, or any transaction on a non-credit-card account', async () => {
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
    );
    expect(nonMatching.candidates).toEqual([]);

    const outflow = await syncCashAccount(
      host.api,
      mapping,
      account([txn({ amount: '-75.00', payee: 'Payment Center' })]) as never,
      emptyWatermark(),
      'CREDIT_CARD',
      ['PAYMENT'],
    );
    expect(outflow.candidates).toEqual([]);

    const nonCard = await syncCashAccount(
      host.api,
      mapping,
      account([txn({ amount: '75.00', payee: 'Online Payment Thank You' })]) as never,
      emptyWatermark(),
      'CASH',
      ['PAYMENT'],
    );
    expect(nonCard.candidates).toEqual([]);
  });
```

Add to `src/lib/sync/run.test.ts`, inside `describe('runSync', ...)`:

```ts
  it('detects a credit-card payment candidate during the account loop', async () => {
    const host = createMockHost();
    host.respond(/\/accounts/, {
      body: JSON.stringify({
        errors: [],
        accounts: [
          {
            org: { name: 'Card Co' },
            id: 'ACT-CARD',
            name: 'Visa',
            currency: 'USD',
            balance: '0.00',
            'balance-date': 1754524800,
            transactions: [
              { id: 'TXN-PAY', posted: 1754438400, amount: '50.00', description: 'Online Payment Thank You' },
            ],
            holdings: [],
          },
        ],
      }),
    });
    host.api.activities.checkImport = vi.fn(async (a: ActivityImport[]) => a.map((row) => ({ ...row, isValid: true })));
    host.api.activities.import = vi.fn(async () => ({
      activities: [],
      importRunId: 'R',
      summary: { total: 1, imported: 1, skipped: 0, duplicates: 0, assetsCreated: 0, success: true },
    }));
    host.api.activities.search = vi.fn(async () => ({ data: [], meta: { totalRowCount: 0 } }));
    host.api.accounts.getAll = vi.fn(async () => [{ id: 'ACT-CARD', accountType: 'CREDIT_CARD', balance: 0 }] as never);

    const cardConfig = {
      baseUrl: 'https://bridge.simplefin.org/simplefin',
      mappings: [
        {
          sfAccountId: 'ACT-CARD',
          wfAccountId: 'ACT-CARD',
          mode: 'CASH' as const,
          sfAccountName: 'Visa',
          orgName: 'Card Co',
        },
      ],
      lookbackDays: 30,
      paymentKeywords: ['PAYMENT'],
    };

    await runSync(host.api, cardConfig);

    // The reconciliation pass (wired in Task 6) will read this back; for now
    // just confirm detection ran without needing a search()/update() call —
    // 0 withdrawal candidates from the empty mock search means nothing to
    // reconcile against yet, and no error was thrown.
    expect(host.api.activities.import).toHaveBeenCalled();
  });
```

Note: this test's `cardConfig` and the `search` mock exist here purely to
prove detection runs end-to-end without throwing; Task 6 adds assertions on
what actually lands in the staging store.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test -- activities.test.ts run.test.ts`
Expected: FAIL — `detectCandidate`/`isPaymentCandidate` don't exist yet, and
`syncCashAccount` always returns `candidates: []` regardless of input.

- [ ] **Step 3: Implement**

In `src/lib/sync/activities.ts`, add after `toActivityImport` and its
imports (add `StagedCandidate` to the import list):

```ts
import type { AccountType, ActivityImport, HostAPI } from '@wealthfolio/addon-sdk';
import type { SfAccount, SfTransaction } from '../simplefin/parse';
import type { AccountMapping } from '../storage/config';
import type { StagedCandidate } from '../storage/staging';
import { advanceWatermark, shouldPush, type Watermark } from '../storage/watermark';
```

```ts
/** Case-insensitive substring match against the user's configured payment keywords. */
export function isPaymentCandidate(text: string, keywords: string[]): boolean {
  const upper = text.toUpperCase();
  return keywords.some((keyword) => keyword.trim() !== '' && upper.includes(keyword.toUpperCase()));
}

/**
 * A `CREDIT` transaction on a credit-card account whose payee/comment looks
 * like a bill payment becomes a staged candidate for TRANSFER_IN/OUT
 * reconciliation (see `./reconciliation.ts`). Returns null for anything that
 * doesn't match — normal purchases and unrelated credits are left untouched.
 */
export function detectCandidate(
  txn: SfTransaction,
  mapping: AccountMapping,
  paymentKeywords: string[],
): StagedCandidate | null {
  const text = txn.payee || txn.description;
  if (!isPaymentCandidate(text, paymentKeywords)) return null;

  return {
    sfTransactionId: txn.id,
    cardAccountId: mapping.wfAccountId,
    cardActivityId: null,
    amount: txn.amount.trim().replace(/^-/, ''),
    postedDate: isoDate(txn.posted),
    comment: text,
    status: 'pending',
    candidateWithdrawalIds: [],
  };
}
```

Update `syncCashAccount`'s return type and its two production-of-candidates
points:

```ts
export async function syncCashAccount(
  api: HostAPI,
  mapping: AccountMapping,
  sfAccount: SfAccount,
  watermark: Watermark,
  accountType: AccountType,
  paymentKeywords: string[],
): Promise<{ result: CashSyncCounts; watermark: Watermark; candidates: StagedCandidate[] }> {
  const candidates = sfAccount.transactions.filter((t) => !t.pending && shouldPush(watermark, t));

  if (candidates.length === 0) {
    return { result: { imported: 0, skipped: 0, duplicates: 0 }, watermark, candidates: [] };
  }

  // ... unchanged checkImport/importable/duplicates/skipped logic ...

  if (importable.length === 0) {
    const advanced = advanceWatermark(
      watermark,
      candidates.filter((_, i) => checked[i].duplicateOfId),
    );
    return { result: { imported: 0, skipped, duplicates }, watermark: advanced, candidates: [] };
  }

  // ... unchanged import() try/catch ...

  const stagedCandidates =
    accountType === 'CREDIT_CARD'
      ? importableTxns
          .filter((t) => !t.amount.trim().startsWith('-'))
          .map((t) => detectCandidate(t, mapping, paymentKeywords))
          .filter((c): c is StagedCandidate => c !== null)
      : [];

  return {
    result: { imported: outcome.summary.imported, skipped, duplicates },
    watermark: advanceWatermark(watermark, importableTxns),
    candidates: stagedCandidates,
  };
}
```

In `src/lib/sync/run.ts`, change `syncOne` to also return detected
candidates, and thread `paymentKeywords` down:

```ts
async function syncOne(
  api: HostAPI,
  baseUrl: string,
  mapping: AccountMapping,
  sfAccount: SfAccount | undefined,
  wfBalances: Map<string, string>,
  wfAccountTypes: Map<string, AccountType>,
  paymentKeywords: string[],
): Promise<{ accountResult: AccountRunResult; candidates: StagedCandidate[] }> {
  const base: AccountRunResult = {
    sfAccountId: mapping.sfAccountId,
    sfAccountName: mapping.sfAccountName,
    orgName: mapping.orgName,
    wfAccountId: mapping.wfAccountId,
    mode: mapping.mode,
    imported: null,
    skipped: null,
    duplicates: null,
    error: null,
    balanceMismatch: null,
  };

  if (!sfAccount) {
    return {
      accountResult: {
        ...base,
        error:
          `SimpleFIN account ${mapping.sfAccountId} was not returned by the Bridge. ` +
          'It may have been disconnected — re-check the mapping.',
      },
      candidates: [],
    };
  }

  try {
    if (mapping.mode === 'HOLDINGS') {
      const { imported, skipped } = await syncHoldingsAccount(api, mapping, sfAccount);
      return {
        accountResult: {
          ...base,
          imported,
          skipped,
          duplicates: 0,
          balanceMismatch: compareBalances(sfAccount.balance, wfBalances.get(mapping.wfAccountId) ?? null),
        },
        candidates: [],
      };
    }

    const watermark = await readWatermark(api, mapping.sfAccountId);
    const isFirstSync = watermark.lastPosted === 0;

    const syncSfAccount = isFirstSync
      ? ((await fetchFullHistory(api, baseUrl, mapping.sfAccountId)) ?? sfAccount)
      : sfAccount;

    const { result, watermark: next, candidates } = await syncCashAccount(
      api,
      mapping,
      syncSfAccount,
      watermark,
      wfAccountTypes.get(mapping.wfAccountId) ?? 'CASH',
      paymentKeywords,
    );
    await writeWatermark(api, mapping.sfAccountId, next);

    const plugImported = isFirstSync ? await pushOpeningBalance(api, mapping, syncSfAccount) : 0;

    return {
      accountResult: {
        ...base,
        imported: result.imported + plugImported,
        skipped: result.skipped,
        duplicates: result.duplicates,
        balanceMismatch: isFirstSync
          ? null
          : compareBalances(sfAccount.balance, wfBalances.get(mapping.wfAccountId) ?? null),
      },
      candidates,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    api.logger.error(`[simplefin] account ${mapping.sfAccountName} failed: ${message}`);
    return { accountResult: { ...base, error: message }, candidates: [] };
  }
}
```

Add the `StagedCandidate` import and update `runSync`'s per-mapping loop:

```ts
import type { StagedCandidate } from '../storage/staging';
```

```ts
  const results: AccountRunResult[] = [];
  const detectedCandidates: StagedCandidate[] = [];
  for (const mapping of config.mappings) {
    const { accountResult, candidates } = await syncOne(
      api,
      config.baseUrl,
      mapping,
      bySfId.get(mapping.sfAccountId),
      wfBalances,
      wfAccountTypes,
      config.paymentKeywords,
    );
    results.push(accountResult);
    detectedCandidates.push(...candidates);
  }
```

`detectedCandidates` isn't persisted or reconciled yet — Task 6 does that.
Leaving it as a local, unused-past-the-loop variable would fail the linter's
unused-var check, so this task ends with it referenced by a temporary
`api.logger.debug` line that Task 6 replaces:

```ts
  if (detectedCandidates.length > 0) {
    api.logger.debug(`[simplefin] detected ${detectedCandidates.length} payment candidate(s) this run`);
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test -- activities.test.ts run.test.ts`
Expected: PASS

- [ ] **Step 5: Run the full suite and type-check**

Run: `pnpm type-check && pnpm test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/lib/sync/activities.ts src/lib/sync/activities.test.ts src/lib/sync/run.ts src/lib/sync/run.test.ts
git commit -m "feat: detect keyword-matched credit-card payments as staging candidates"
```

---

### Task 5: Reconciliation core — matching, reclassification, expiry

**Files:**
- Create: `src/lib/sync/reconciliation.ts`
- Test: `src/lib/sync/reconciliation.test.ts`
- Modify: `src/lib/sync/balance.ts` (export `normalise`)
- Modify: `src/test/mockHost.ts` (add `activities.search`/`activities.update` mocks)
- Modify: `manifest.json` (declare `search`/`update` permissions)

**Interfaces:**
- Consumes: `StagedCandidate` from `../storage/staging`; `normalise` from `./balance`; `ActivityDetails`/`ActivityUpdate`/`HostAPI` from `@wealthfolio/addon-sdk`.
- Produces: `runReconciliation(api, candidates, cashAccountIds, nowSeconds): Promise<{ candidates: StagedCandidate[]; summary: { resolved: number; expired: number } }>`, `resolveAmbiguous(api, candidate, cashAccountIds, chosenWithdrawalId): Promise<void>`, `findCardActivity(api, candidate): Promise<ActivityDetails | null>`, `describeWithdrawals(api, cashAccountIds, ids): Promise<ActivityDetails[]>` — all exported from `src/lib/sync/reconciliation.ts`, for Task 6 (wiring) and Task 7 (UI) to consume.

- [ ] **Step 1: Write the failing tests**

```ts
// src/lib/sync/reconciliation.test.ts
import { describe, expect, it, vi } from 'vitest';
import type { ActivityDetails } from '@wealthfolio/addon-sdk';
import { createMockHost } from '../../test/mockHost';
import type { StagedCandidate } from '../storage/staging';
import { describeWithdrawals, findCardActivity, resolveAmbiguous, runReconciliation } from './reconciliation';

const NOW = 1754438400 + 5 * 86_400; // 5 days after the fixtures' posted date

const candidate = (over: Partial<StagedCandidate> = {}): StagedCandidate => ({
  sfTransactionId: 'TXN-1',
  cardAccountId: 'WF-CARD',
  cardActivityId: null,
  amount: '50.00',
  postedDate: '2025-08-06',
  comment: 'Online Payment Thank You',
  status: 'pending',
  candidateWithdrawalIds: [],
  ...over,
});

const cardActivity = (over: Partial<ActivityDetails> = {}): ActivityDetails =>
  ({
    id: 'CARD-ACT-1',
    accountId: 'WF-CARD',
    activityType: 'CREDIT',
    date: '2025-08-06T00:00:00+00:00',
    amount: '50',
    currency: 'USD',
    comment: 'Online Payment Thank You',
    ...over,
  }) as ActivityDetails;

const withdrawalActivity = (over: Partial<ActivityDetails> = {}): ActivityDetails =>
  ({
    id: 'CASH-ACT-1',
    accountId: 'WF-CASH',
    activityType: 'WITHDRAWAL',
    date: '2025-08-05T00:00:00+00:00',
    amount: '50',
    currency: 'USD',
    comment: 'Bill Pay',
    ...over,
  }) as ActivityDetails;

describe('runReconciliation', () => {
  it('resolves a unique match by reclassifying both legs', async () => {
    const host = createMockHost();
    host.api.activities.search = vi.fn(async (page: number, _size: number, filters: { activityTypes: string }) => {
      if (page > 0) return { data: [], meta: { totalRowCount: 0 } };
      if (filters.activityTypes === 'CREDIT') return { data: [cardActivity()], meta: { totalRowCount: 1 } };
      return { data: [withdrawalActivity()], meta: { totalRowCount: 1 } };
    }) as never;
    host.api.activities.update = vi.fn(async (u) => u as never);

    const { candidates, summary } = await runReconciliation(host.api, [candidate()], ['WF-CASH'], NOW);

    expect(candidates).toHaveLength(0);
    expect(summary.resolved).toBe(1);
    expect(host.api.activities.update).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'CARD-ACT-1', activityType: 'TRANSFER_IN' }),
    );
    expect(host.api.activities.update).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'CASH-ACT-1', activityType: 'TRANSFER_OUT' }),
    );
  });

  it('stays pending with zero withdrawal matches', async () => {
    const host = createMockHost();
    host.api.activities.search = vi.fn(async (_p: number, _s: number, filters: { activityTypes: string }) => {
      if (filters.activityTypes === 'CREDIT') return { data: [cardActivity()], meta: { totalRowCount: 1 } };
      return { data: [], meta: { totalRowCount: 0 } };
    }) as never;

    const { candidates, summary } = await runReconciliation(host.api, [candidate()], ['WF-CASH'], NOW);

    expect(candidates).toHaveLength(1);
    expect(candidates[0].status).toBe('pending');
    expect(candidates[0].cardActivityId).toBe('CARD-ACT-1');
    expect(summary.resolved).toBe(0);
    expect(host.api.activities.update).not.toHaveBeenCalled();
  });

  it('marks ambiguous with two or more withdrawal matches, never auto-picking one', async () => {
    const host = createMockHost();
    host.api.activities.search = vi.fn(async (_p: number, _s: number, filters: { activityTypes: string }) => {
      if (filters.activityTypes === 'CREDIT') return { data: [cardActivity()], meta: { totalRowCount: 1 } };
      return {
        data: [withdrawalActivity(), withdrawalActivity({ id: 'CASH-ACT-2', accountId: 'WF-CASH-2' })],
        meta: { totalRowCount: 2 },
      };
    }) as never;

    const { candidates } = await runReconciliation(host.api, [candidate()], ['WF-CASH', 'WF-CASH-2'], NOW);

    expect(candidates[0].status).toBe('ambiguous');
    expect(candidates[0].candidateWithdrawalIds.sort()).toEqual(['CASH-ACT-1', 'CASH-ACT-2']);
    expect(host.api.activities.update).not.toHaveBeenCalled();
  });

  it('excludes a withdrawal outside the 3-day match window', async () => {
    const host = createMockHost();
    host.api.activities.search = vi.fn(async (_p: number, _s: number, filters: { activityTypes: string }) => {
      if (filters.activityTypes === 'CREDIT') return { data: [cardActivity()], meta: { totalRowCount: 1 } };
      return {
        data: [withdrawalActivity({ date: '2025-07-30T00:00:00+00:00' })], // 7 days before the card credit
        meta: { totalRowCount: 1 },
      };
    }) as never;

    const { candidates } = await runReconciliation(host.api, [candidate()], ['WF-CASH'], NOW);
    expect(candidates[0].status).toBe('pending');
  });

  it('matches amounts by normalised value, not raw string equality', async () => {
    const host = createMockHost();
    host.api.activities.search = vi.fn(async (_p: number, _s: number, filters: { activityTypes: string }) => {
      if (filters.activityTypes === 'CREDIT') return { data: [cardActivity()], meta: { totalRowCount: 1 } };
      // Wealthfolio's persisted form ("50") differs from the candidate's stored form ("50.00").
      return { data: [withdrawalActivity({ amount: '50' })], meta: { totalRowCount: 1 } };
    }) as never;
    host.api.activities.update = vi.fn(async (u) => u as never);

    const { summary } = await runReconciliation(host.api, [candidate({ amount: '50.00' })], ['WF-CASH'], NOW);
    expect(summary.resolved).toBe(1);
  });

  it('drops a candidate older than the 7-day expiry without creating a transfer', async () => {
    const host = createMockHost();
    host.api.activities.search = vi.fn();

    const old = candidate({ postedDate: '2025-07-01' });
    const { candidates, summary } = await runReconciliation(host.api, [old], ['WF-CASH'], NOW);

    expect(candidates).toHaveLength(0);
    expect(summary.expired).toBe(1);
    expect(host.api.activities.search).not.toHaveBeenCalled();
  });

  it('isolates a per-candidate failure so other candidates still resolve', async () => {
    const host = createMockHost();
    host.api.activities.search = vi.fn(async (_p: number, _s: number, filters: { accountIds: string[]; activityTypes: string }) => {
      if (filters.accountIds[0] === 'WF-CARD-BAD') throw new Error('search exploded');
      if (filters.activityTypes === 'CREDIT') return { data: [cardActivity()], meta: { totalRowCount: 1 } };
      return { data: [withdrawalActivity()], meta: { totalRowCount: 1 } };
    }) as never;
    host.api.activities.update = vi.fn(async (u) => u as never);

    const bad = candidate({ sfTransactionId: 'TXN-BAD', cardAccountId: 'WF-CARD-BAD' });
    const good = candidate({ sfTransactionId: 'TXN-GOOD' });

    const { candidates, summary } = await runReconciliation(host.api, [bad, good], ['WF-CASH'], NOW);

    expect(summary.resolved).toBe(1);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].sfTransactionId).toBe('TXN-BAD');
    expect(host.api.logger.error).toHaveBeenCalledWith(expect.stringContaining('TXN-BAD'));
  });

  it('paginates search() from page 0 until totalRowCount is covered', async () => {
    const host = createMockHost();
    const manyWithdrawals = Array.from({ length: 3 }, (_, i) => withdrawalActivity({ id: `PAGE-${i}` }));
    host.api.activities.search = vi.fn(async (page: number, pageSize: number, filters: { activityTypes: string }) => {
      if (filters.activityTypes === 'CREDIT') return { data: [cardActivity()], meta: { totalRowCount: 1 } };
      const slice = manyWithdrawals.slice(page * pageSize, page * pageSize + pageSize);
      return { data: slice, meta: { totalRowCount: manyWithdrawals.length } };
    }) as never;

    // pageSize is internal (200), so force multiple pages by shrinking the fixture set relative
    // to a a tiny stand-in: this test only needs to prove page starts at 0 and the loop terminates.
    await runReconciliation(host.api, [candidate()], ['WF-CASH'], NOW);
    expect(host.api.activities.search).toHaveBeenCalledWith(0, expect.any(Number), expect.anything(), '');
  });
});

describe('findCardActivity', () => {
  it('resolves by accountId/amount/date/comment when cardActivityId is unknown', async () => {
    const host = createMockHost();
    host.api.activities.search = vi.fn(async () => ({ data: [cardActivity()], meta: { totalRowCount: 1 } })) as never;

    const found = await findCardActivity(host.api, candidate());
    expect(found?.id).toBe('CARD-ACT-1');
  });

  it('resolves by id directly once cardActivityId is known', async () => {
    const host = createMockHost();
    host.api.activities.search = vi.fn(async () => ({
      data: [cardActivity(), cardActivity({ id: 'OTHER', comment: 'different' })],
      meta: { totalRowCount: 2 },
    })) as never;

    const found = await findCardActivity(host.api, candidate({ cardActivityId: 'OTHER' }));
    expect(found?.id).toBe('OTHER');
  });
});

describe('describeWithdrawals', () => {
  it('returns full details for the requested ids only', async () => {
    const host = createMockHost();
    host.api.activities.search = vi.fn(async () => ({
      data: [withdrawalActivity({ id: 'A' }), withdrawalActivity({ id: 'B' }), withdrawalActivity({ id: 'C' })],
      meta: { totalRowCount: 3 },
    })) as never;

    const found = await describeWithdrawals(host.api, ['WF-CASH'], ['A', 'C']);
    expect(found.map((r) => r.id).sort()).toEqual(['A', 'C']);
  });
});

describe('resolveAmbiguous', () => {
  it('reclassifies the chosen withdrawal and the resolved card activity', async () => {
    const host = createMockHost();
    host.api.activities.search = vi.fn(async (_p: number, _s: number, filters: { activityTypes: string }) => {
      if (filters.activityTypes === 'CREDIT') return { data: [cardActivity()], meta: { totalRowCount: 1 } };
      return { data: [withdrawalActivity(), withdrawalActivity({ id: 'OTHER' })], meta: { totalRowCount: 2 } };
    }) as never;
    host.api.activities.update = vi.fn(async (u) => u as never);

    await resolveAmbiguous(
      host.api,
      candidate({ status: 'ambiguous', cardActivityId: 'CARD-ACT-1', candidateWithdrawalIds: ['CASH-ACT-1', 'OTHER'] }),
      ['WF-CASH'],
      'CASH-ACT-1',
    );

    expect(host.api.activities.update).toHaveBeenCalledWith(expect.objectContaining({ id: 'CASH-ACT-1', activityType: 'TRANSFER_OUT' }));
    expect(host.api.activities.update).toHaveBeenCalledWith(expect.objectContaining({ id: 'CARD-ACT-1', activityType: 'TRANSFER_IN' }));
  });

  it('throws if the chosen withdrawal can no longer be found', async () => {
    const host = createMockHost();
    host.api.activities.search = vi.fn(async (_p: number, _s: number, filters: { activityTypes: string }) => {
      if (filters.activityTypes === 'CREDIT') return { data: [cardActivity()], meta: { totalRowCount: 1 } };
      return { data: [], meta: { totalRowCount: 0 } };
    }) as never;

    await expect(
      resolveAmbiguous(host.api, candidate({ cardActivityId: 'CARD-ACT-1' }), ['WF-CASH'], 'GONE'),
    ).rejects.toThrow(/GONE/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test -- reconciliation.test.ts`
Expected: FAIL — `./reconciliation` does not exist, and `mockHost`'s
`api.activities.search`/`.update` are `undefined`.

- [ ] **Step 3: Implement**

First, export `normalise` from `src/lib/sync/balance.ts` (only the `export`
keyword changes — the function body is untouched):

```ts
/**
 * Compare two decimal strings without going through float. Balances are
 * compared by normalised value, so "100.0" and "100.00" agree. Reused by
 * `reconciliation.ts` for the same reason: Wealthfolio's persisted amount
 * strings don't preserve SimpleFIN's original decimal precision.
 */
export function normalise(value: string): string {
  const trimmed = value.trim();
  const negative = trimmed.startsWith('-');
  const [whole, fraction = ''] = trimmed.replace(/^[-+]/, '').split('.');
  const cleanWhole = whole.replace(/^0+(?=\d)/, '');
  const cleanFraction = fraction.replace(/0+$/, '');
  const magnitude = cleanFraction ? `${cleanWhole}.${cleanFraction}` : cleanWhole;

  if (/^0(\.0*)?$/.test(magnitude)) return '0';
  return negative ? `-${magnitude}` : magnitude;
}
```

Add `activities.search`/`activities.update` mocks to
`src/test/mockHost.ts` (inside the existing `activities:` object):

```ts
    activities: {
      checkImport: vi.fn(),
      import: vi.fn(),
      search: vi.fn(async () => ({ data: [], meta: { totalRowCount: 0 } })),
      update: vi.fn(async (activity: unknown) => activity),
    },
```

Add `search`/`update` to `manifest.json`'s `activities` permission block:

```json
    {
      "category": "activities",
      "functions": [
        { "name": "checkImport", "isDeclared": true, "isDetected": false },
        { "name": "import", "isDeclared": true, "isDetected": false },
        { "name": "search", "isDeclared": true, "isDetected": false },
        { "name": "update", "isDeclared": true, "isDetected": false }
      ],
      "purpose": "Import cash transactions fetched from SimpleFIN, and reconcile credit-card payments into linked transfers."
    },
```

Now create `src/lib/sync/reconciliation.ts`:

```ts
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test -- reconciliation.test.ts balance.test.ts`
Expected: PASS

- [ ] **Step 5: Run the full suite and type-check**

Run: `pnpm type-check && pnpm test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/lib/sync/reconciliation.ts src/lib/sync/reconciliation.test.ts src/lib/sync/balance.ts src/test/mockHost.ts manifest.json
git commit -m "feat: add reconciliation pass matching staged candidates to withdrawals"
```

---

### Task 6: Wire reconciliation into `runSync`

**Files:**
- Modify: `src/lib/sync/run.ts`
- Test: `src/lib/sync/run.test.ts`

**Interfaces:**
- Consumes: `readStaging`/`writeStaging` from `../storage/staging`; `runReconciliation` from `./reconciliation`.
- Produces: `runSync` now persists detected candidates and reconciles the full staged list every run — no new exports.

- [ ] **Step 1: Write the failing test**

Add reconciliation coverage alongside Task 4's detection test, inside
`describe('runSync', ...)` in `src/lib/sync/run.test.ts`. First add this
import to the file's existing top-of-file import block (alongside the other
`../storage/*` imports already there):

```ts
import { readStaging, writeStaging } from '../storage/staging';
```

Then add these three `it()` blocks inside the existing `describe('runSync', ...)`:

```ts
  it('persists a detected candidate and reconciles it against an existing withdrawal in the same run', async () => {
    const host = createMockHost();
    host.respond(/\/accounts/, {
      body: JSON.stringify({
        errors: [],
        accounts: [
          {
            org: { name: 'Card Co' },
            id: 'ACT-CARD',
            name: 'Visa',
            currency: 'USD',
            balance: '0.00',
            'balance-date': 1754438400,
            transactions: [
              { id: 'TXN-PAY', posted: 1754438400, amount: '50.00', description: 'Online Payment Thank You' },
            ],
            holdings: [],
          },
        ],
      }),
    });
    host.api.activities.checkImport = vi.fn(async (a: ActivityImport[]) => a.map((row) => ({ ...row, isValid: true })));
    host.api.activities.import = vi.fn(async () => ({
      activities: [],
      importRunId: 'R',
      summary: { total: 1, imported: 1, skipped: 0, duplicates: 0, assetsCreated: 0, success: true },
    }));
    host.api.activities.search = vi.fn(async (_p: number, _s: number, filters: { activityTypes: string }) => {
      if (filters.activityTypes === 'CREDIT') {
        return {
          data: [
            {
              id: 'CARD-ACT-1',
              accountId: 'ACT-CARD',
              activityType: 'CREDIT',
              date: '2025-08-06T00:00:00+00:00',
              amount: '50',
              currency: 'USD',
              comment: 'Online Payment Thank You',
            },
          ],
          meta: { totalRowCount: 1 },
        };
      }
      return {
        data: [
          {
            id: 'CASH-ACT-1',
            accountId: 'WF-CASH',
            activityType: 'WITHDRAWAL',
            date: '2025-08-05T00:00:00+00:00',
            amount: '50',
            currency: 'USD',
            comment: 'Bill Pay',
          },
        ],
        meta: { totalRowCount: 1 },
      };
    }) as never;
    host.api.activities.update = vi.fn(async (u) => u as never);
    host.api.accounts.getAll = vi.fn(async () => [
      { id: 'ACT-CARD', accountType: 'CREDIT_CARD', balance: 0 },
      { id: 'WF-CASH', accountType: 'CASH', balance: 0 },
    ] as never);

    const cardConfig = {
      baseUrl: 'https://bridge.simplefin.org/simplefin',
      mappings: [
        { sfAccountId: 'ACT-CARD', wfAccountId: 'ACT-CARD', mode: 'CASH' as const, sfAccountName: 'Visa', orgName: 'Card Co' },
        { sfAccountId: 'WF-CASH', wfAccountId: 'WF-CASH', mode: 'CASH' as const, sfAccountName: 'Checking', orgName: 'Bank A' },
      ],
      lookbackDays: 30,
      paymentKeywords: ['PAYMENT'],
    };

    await runSync(host.api, cardConfig);

    expect(host.api.activities.update).toHaveBeenCalledWith(expect.objectContaining({ id: 'CARD-ACT-1', activityType: 'TRANSFER_IN' }));
    expect(host.api.activities.update).toHaveBeenCalledWith(expect.objectContaining({ id: 'CASH-ACT-1', activityType: 'TRANSFER_OUT' }));
    expect(await readStaging(host.api)).toEqual([]);
  });

  it('keeps an unresolved candidate staged for the next run', async () => {
    const host = createMockHost();
    host.respond(/\/accounts/, { body: JSON.stringify({ errors: [], accounts: [] }) });
    host.api.accounts.getAll = vi.fn(async () => [{ id: 'ACT-CARD', accountType: 'CREDIT_CARD', balance: 0 }] as never);

    await writeStaging(host.api, [
      {
        sfTransactionId: 'TXN-OLD',
        cardAccountId: 'ACT-CARD',
        cardActivityId: null,
        amount: '50.00',
        postedDate: new Date().toISOString().slice(0, 10),
        comment: 'Online Payment Thank You',
        status: 'pending',
        candidateWithdrawalIds: [],
      },
    ]);
    host.api.activities.search = vi.fn(async () => ({ data: [], meta: { totalRowCount: 0 } })) as never;

    await runSync(host.api, {
      baseUrl: 'https://bridge.simplefin.org/simplefin',
      mappings: [],
      lookbackDays: 30,
      paymentKeywords: ['PAYMENT'],
    });

    const staged = await readStaging(host.api);
    expect(staged).toHaveLength(1);
    expect(staged[0].sfTransactionId).toBe('TXN-OLD');
  });

  it('does not let a reconciliation failure fail the whole sync run', async () => {
    const host = okHost();
    await writeStaging(host.api, [
      {
        sfTransactionId: 'TXN-BAD',
        cardAccountId: 'WF-1',
        cardActivityId: null,
        amount: '50.00',
        postedDate: new Date().toISOString().slice(0, 10),
        comment: 'Payment',
        status: 'pending',
        candidateWithdrawalIds: [],
      },
    ]);
    host.api.activities.search = vi.fn(async () => {
      throw new Error('search unavailable');
    }) as never;

    const run = await runSync(host.api, config);
    expect(run.accounts.every((a) => a.error === null)).toBe(true);
    expect(host.api.logger.error).toHaveBeenCalledWith(expect.stringContaining('search unavailable'));
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test -- run.test.ts`
Expected: FAIL — `runSync` doesn't yet read/write staging or call
`runReconciliation`.

- [ ] **Step 3: Implement**

In `src/lib/sync/run.ts`, add the imports:

```ts
import { readStaging, writeStaging } from '../storage/staging';
import { runReconciliation } from './reconciliation';
```

Replace the Task-4 placeholder debug log with the real wiring, at the end of
`runSync` (after the per-mapping loop, before building `run`):

```ts
  const cashAccountIds = config.mappings.filter((m) => m.mode === 'CASH').map((m) => m.wfAccountId);
  try {
    const existingStaging = await readStaging(api);
    const { candidates: remainingCandidates } = await runReconciliation(
      api,
      [...existingStaging, ...detectedCandidates],
      cashAccountIds,
      nowSeconds,
    );
    await writeStaging(api, remainingCandidates);
  } catch (error) {
    // Reconciliation is a secondary pass over transactions that already
    // synced successfully — a failure here must not undo or block the run
    // that already happened.
    api.logger.error(`[simplefin] reconciliation pass failed: ${String(error)}`);
  }
```

This reuses the `nowSeconds` already computed earlier in `runSync` for
`lookbackFloor` — no second `Date.now()` call site.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test -- run.test.ts`
Expected: PASS

- [ ] **Step 5: Run the full suite and type-check**

Run: `pnpm type-check && pnpm test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/lib/sync/run.ts src/lib/sync/run.test.ts
git commit -m "feat: wire reconciliation pass into runSync"
```

---

### Task 7: Staged Transactions UI

**Files:**
- Create: `src/components/StagedTransactionsList.tsx`
- Test: `src/components/StagedTransactionsList.test.tsx`

**Interfaces:**
- Consumes: `StagedCandidate` from `../lib/storage/staging`; `readStaging`/`writeStaging` from `../lib/storage/staging`; `findCardActivity`/`describeWithdrawals`/`resolveAmbiguous` from `../lib/sync/reconciliation`.
- Produces: `StagedTransactionsList({ api, cashAccountIds }: { api: HostAPI; cashAccountIds: string[] })` — a self-contained component that loads its own staging data (same pattern as `HistoryList`/`AccountMapTable` receiving `api` directly), for Task 8 to mount.

- [ ] **Step 1: Write the failing tests**

```tsx
// src/components/StagedTransactionsList.test.tsx
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { createMockHost } from '../test/mockHost';
import { writeStaging, type StagedCandidate } from '../lib/storage/staging';
import { StagedTransactionsList } from './StagedTransactionsList';

const pending: StagedCandidate = {
  sfTransactionId: 'TXN-1',
  cardAccountId: 'WF-CARD',
  cardActivityId: null,
  amount: '50.00',
  postedDate: '2026-08-01',
  comment: 'Online Payment Thank You',
  status: 'pending',
  candidateWithdrawalIds: [],
};

const ambiguous: StagedCandidate = {
  sfTransactionId: 'TXN-2',
  cardAccountId: 'WF-CARD',
  cardActivityId: 'CARD-ACT-2',
  amount: '80.00',
  postedDate: '2026-08-02',
  comment: 'Autopay',
  status: 'ambiguous',
  candidateWithdrawalIds: ['CASH-A', 'CASH-B'],
};

describe('StagedTransactionsList', () => {
  it('shows a message when there is nothing staged', async () => {
    const host = createMockHost();
    render(<StagedTransactionsList api={host.api} cashAccountIds={['WF-CASH']} />);
    expect(await screen.findByText(/no staged transactions/i)).toBeInTheDocument();
  });

  it('lists pending and ambiguous candidates with their amount and comment', async () => {
    const host = createMockHost();
    await writeStaging(host.api, [pending, ambiguous]);

    render(<StagedTransactionsList api={host.api} cashAccountIds={['WF-CASH']} />);

    expect(await screen.findByText('50.00')).toBeInTheDocument();
    expect(screen.getByText('Online Payment Thank You')).toBeInTheDocument();
    expect(screen.getByText('80.00')).toBeInTheDocument();
    expect(screen.getByText('Autopay')).toBeInTheDocument();
  });

  it('dismisses a pending candidate without calling the host activities API', async () => {
    const host = createMockHost();
    await writeStaging(host.api, [pending]);

    render(<StagedTransactionsList api={host.api} cashAccountIds={['WF-CASH']} />);
    await userEvent.click(await screen.findByRole('button', { name: /dismiss/i }));

    expect(await screen.findByText(/no staged transactions/i)).toBeInTheDocument();
    expect(host.api.activities.update).not.toHaveBeenCalled();
    expect(host.storage.get('simplefin.staging')).toBe('[]');
  });

  it('shows a picker for an ambiguous candidate and resolves the chosen withdrawal', async () => {
    const host = createMockHost();
    await writeStaging(host.api, [ambiguous]);
    host.api.activities.search = vi.fn(async (_p: number, _s: number, filters: { activityTypes: string }) => {
      if (filters.activityTypes === 'CREDIT') {
        return {
          data: [{ id: 'CARD-ACT-2', accountId: 'WF-CARD', activityType: 'CREDIT', date: '2026-08-02T00:00:00+00:00', amount: '80', currency: 'USD', comment: 'Autopay' }],
          meta: { totalRowCount: 1 },
        };
      }
      return {
        data: [
          { id: 'CASH-A', accountId: 'WF-CASH', activityType: 'WITHDRAWAL', date: '2026-07-31T00:00:00+00:00', amount: '80', currency: 'USD', comment: 'Bill Pay A' },
          { id: 'CASH-B', accountId: 'WF-CASH', activityType: 'WITHDRAWAL', date: '2026-07-30T00:00:00+00:00', amount: '80', currency: 'USD', comment: 'Bill Pay B' },
        ],
        meta: { totalRowCount: 2 },
      };
    }) as never;
    host.api.activities.update = vi.fn(async (u) => u as never);

    render(<StagedTransactionsList api={host.api} cashAccountIds={['WF-CASH']} />);

    const row = (await screen.findByText('Autopay')).closest('tr') as HTMLElement;
    await userEvent.click(within(row).getByRole('button', { name: /resolve/i }));

    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByText(/bill pay a/i));
    await userEvent.click(within(dialog).getByRole('button', { name: /confirm/i }));

    expect(host.api.activities.update).toHaveBeenCalledWith(expect.objectContaining({ id: 'CASH-A', activityType: 'TRANSFER_OUT' }));
    expect(await screen.findByText(/no staged transactions/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test -- StagedTransactionsList.test.tsx`
Expected: FAIL — the component does not exist.

- [ ] **Step 3: Implement**

```tsx
// src/components/StagedTransactionsList.tsx
import type { ActivityDetails, HostAPI } from '@wealthfolio/addon-sdk';
import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@wealthfolio/ui';
import { useEffect, useState } from 'react';
import { describeWithdrawals, resolveAmbiguous } from '../lib/sync/reconciliation';
import { readStaging, writeStaging, type StagedCandidate } from '../lib/storage/staging';
import { compactCellClassName, compactHeadClassName } from './tableStyle';

export interface StagedTransactionsListProps {
  api: HostAPI;
  cashAccountIds: string[];
}

export function StagedTransactionsList({ api, cashAccountIds }: StagedTransactionsListProps) {
  const [candidates, setCandidates] = useState<StagedCandidate[] | null>(null);
  const [resolving, setResolving] = useState<StagedCandidate | null>(null);
  const [choices, setChoices] = useState<ActivityDetails[]>([]);
  const [chosenId, setChosenId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setCandidates(await readStaging(api));
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function dismiss(target: StagedCandidate) {
    const next = (candidates ?? []).filter((c) => c.sfTransactionId !== target.sfTransactionId);
    setCandidates(next);
    await writeStaging(api, next);
  }

  async function openResolve(candidate: StagedCandidate) {
    setError(null);
    setResolving(candidate);
    setChosenId(null);
    setChoices(await describeWithdrawals(api, cashAccountIds, candidate.candidateWithdrawalIds));
  }

  async function confirmResolve() {
    if (!resolving || !chosenId) return;
    try {
      await resolveAmbiguous(api, resolving, cashAccountIds, chosenId);
      const next = (candidates ?? []).filter((c) => c.sfTransactionId !== resolving.sfTransactionId);
      setCandidates(next);
      await writeStaging(api, next);
      setResolving(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  if (candidates === null) return null;
  if (candidates.length === 0) return <p className="text-muted-foreground text-sm">No staged transactions.</p>;

  return (
    <>
      <Table aria-label="Staged transactions">
        <TableHeader>
          <TableRow>
            <TableHead className={compactHeadClassName}>Amount</TableHead>
            <TableHead className={compactHeadClassName}>Comment</TableHead>
            <TableHead className={compactHeadClassName}>Status</TableHead>
            <TableHead className={compactHeadClassName}>Action</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {candidates.map((candidate) => (
            <TableRow key={candidate.sfTransactionId}>
              <TableCell className={compactCellClassName}>{candidate.amount}</TableCell>
              <TableCell className={compactCellClassName}>{candidate.comment}</TableCell>
              <TableCell className={compactCellClassName}>{candidate.status}</TableCell>
              <TableCell className={compactCellClassName}>
                <div className="flex gap-2">
                  {candidate.status === 'ambiguous' && (
                    <Button size="sm" onClick={() => openResolve(candidate)}>
                      Resolve
                    </Button>
                  )}
                  <Button size="sm" variant="outline" onClick={() => dismiss(candidate)}>
                    Dismiss
                  </Button>
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <Dialog open={resolving !== null} onOpenChange={(open) => !open && setResolving(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Pick the matching withdrawal</DialogTitle>
          </DialogHeader>
          {error && <p className="text-destructive text-sm">{error}</p>}
          <div className="space-y-2">
            {choices.map((choice) => (
              <label key={choice.id} className="flex items-center gap-2">
                <input
                  type="radio"
                  name="withdrawal-choice"
                  value={choice.id}
                  checked={chosenId === choice.id}
                  onChange={() => setChosenId(choice.id)}
                />
                {choice.comment} — {choice.amount}
              </label>
            ))}
          </div>
          <DialogFooter>
            <Button onClick={confirmResolve} disabled={!chosenId}>
              Confirm
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test -- StagedTransactionsList.test.tsx`
Expected: PASS. (`Dialog`/`DialogContent`/`DialogFooter`/`DialogHeader`/
`DialogTitle` are confirmed exported from `@wealthfolio/ui`'s root index,
built on Radix's `react-dialog` — `DialogContent` carries Radix's `dialog`
role automatically, which is what `screen.findByRole('dialog')` in the test
targets.)

- [ ] **Step 5: Commit**

```bash
git add src/components/StagedTransactionsList.tsx src/components/StagedTransactionsList.test.tsx
git commit -m "feat: add Staged Transactions list with dismiss and ambiguous-resolve UI"
```

---

### Task 8: Wire the Staged tab into SyncPage

**Files:**
- Modify: `src/pages/SyncPage.tsx`
- Test: `src/pages/SyncPage.sync.test.tsx`

**Interfaces:**
- Consumes: `StagedTransactionsList` from `../components/StagedTransactionsList`.
- Produces: no new exports — `SyncPage` gains a "Staged" tab.

- [ ] **Step 1: Write the failing test**

Add to `src/pages/SyncPage.sync.test.tsx`:

```ts
  it('renders staged candidates under the Staged tab', async () => {
    const host = createMockHost();
    seedConfig(host, [CHECKING_MAPPING]);
    host.respond(/\/accounts/, {
      body: JSON.stringify({
        accounts: [
          { id: 'ACT-1', name: 'Checking', currency: 'USD', balance: '100.00', 'balance-date': 1700000000, org: { name: 'Bank A' }, transactions: [] },
        ],
        errors: [],
      }),
    });
    host.api.accounts.getAll = vi.fn(async () => [{ id: 'WF-1', name: 'My Checking', balance: 100 }] as never);
    await host.api.storage.set(
      'simplefin.staging',
      JSON.stringify([
        {
          sfTransactionId: 'TXN-1',
          cardAccountId: 'WF-CARD',
          cardActivityId: null,
          amount: '50.00',
          postedDate: '2026-08-01',
          comment: 'Online Payment Thank You',
          status: 'pending',
          candidateWithdrawalIds: [],
        },
      ]),
    );

    render(<SyncPage api={host.api} />);
    await screen.findByText('Checking');
    await userEvent.click(await screen.findByRole('tab', { name: /staged/i }));

    expect(await screen.findByText('Online Payment Thank You')).toBeInTheDocument();
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- SyncPage.sync.test.tsx`
Expected: FAIL — there is no "Staged" tab.

- [ ] **Step 3: Implement**

In `src/pages/SyncPage.tsx`, import the new component:

```ts
import { StagedTransactionsList } from '../components/StagedTransactionsList';
```

Add a tab trigger alongside the existing ones:

```tsx
            <TabsTrigger value="staged" className="justify-start">
              Staged
            </TabsTrigger>
```

Add the corresponding tab content, deriving `cashAccountIds` from the
current config:

```tsx
          <TabsContent value="staged" className="mt-0">
            <StagedTransactionsList
              api={api}
              cashAccountIds={config.mappings.filter((m) => m.mode === 'CASH').map((m) => m.wfAccountId)}
            />
          </TabsContent>
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test -- SyncPage.sync.test.tsx`
Expected: PASS

- [ ] **Step 5: Run the full suite and type-check**

Run: `pnpm type-check && pnpm test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/pages/SyncPage.tsx src/pages/SyncPage.sync.test.tsx
git commit -m "feat: add Staged tab to the Sync page"
```

---

### Task 9: Settings — payment keywords editor

**Files:**
- Modify: `src/components/SettingsPanel.tsx`
- Test: `src/components/SettingsPanel.test.tsx`

**Interfaces:**
- Consumes: `SyncConfig.paymentKeywords` (Task 1).
- Produces: `SettingsPanelProps` gains `paymentKeywords: string[]` and `onPaymentKeywordsChange: (keywords: string[]) => void`; `SyncPage.tsx` passes these through and persists via the same `writeConfig` pattern as `persistLookbackDays`.

- [ ] **Step 1: Write the failing tests**

In `src/components/SettingsPanel.test.tsx`, replace the existing
`renderPanel` helper function with this extended version (same name, now
also wiring the two new props):

```ts
function renderPanel(overrides: Partial<Parameters<typeof SettingsPanel>[0]> = {}) {
  const host = createMockHost();
  const onDisconnected = vi.fn();
  const onLookbackDaysChange = vi.fn();
  const onPaymentKeywordsChange = vi.fn();
  render(
    <SettingsPanel
      api={host.api}
      baseUrl={BASE_URL}
      lookbackDays={DEFAULT_LOOKBACK_DAYS}
      onLookbackDaysChange={onLookbackDaysChange}
      paymentKeywords={DEFAULT_PAYMENT_KEYWORDS}
      onPaymentKeywordsChange={onPaymentKeywordsChange}
      onDisconnected={onDisconnected}
      {...overrides}
    />,
  );
  return { host, onDisconnected, onLookbackDaysChange, onPaymentKeywordsChange };
}
```

Update the existing `import { DEFAULT_LOOKBACK_DAYS, ... } from '../lib/storage/config'` line to also import `DEFAULT_PAYMENT_KEYWORDS`. Then add
these three `it()` blocks inside the existing `describe('SettingsPanel', ...)`:

```ts
  it('shows the current keywords as a comma-separated list', () => {
    renderPanel({ paymentKeywords: ['PAYMENT', 'AUTOPAY'] });
    expect(screen.getByLabelText(/payment keywords/i)).toHaveValue('PAYMENT, AUTOPAY');
  });

  it('disables Save until the keyword list actually changes', async () => {
    renderPanel({ paymentKeywords: ['PAYMENT'] });
    const input = screen.getByLabelText(/payment keywords/i);
    const save = screen.getByRole('button', { name: /^save keywords$/i });

    expect(save).toBeDisabled();
    await userEvent.type(input, ', AUTOPAY');
    expect(save).toBeEnabled();
  });

  it('saves the comma-separated input as a trimmed keyword array', async () => {
    const { onPaymentKeywordsChange } = renderPanel({ paymentKeywords: ['PAYMENT'] });
    const input = screen.getByLabelText(/payment keywords/i);

    await userEvent.clear(input);
    await userEvent.type(input, ' payment ,  autopay ,thank you ');
    await userEvent.click(screen.getByRole('button', { name: /^save keywords$/i }));

    expect(onPaymentKeywordsChange).toHaveBeenCalledWith(['payment', 'autopay', 'thank you']);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test -- SettingsPanel.test.tsx`
Expected: FAIL — `SettingsPanel` doesn't accept or render `paymentKeywords`.

- [ ] **Step 3: Implement**

In `src/components/SettingsPanel.tsx`, extend the props and add draft state:

```ts
export interface SettingsPanelProps {
  api: HostAPI;
  baseUrl: string;
  lookbackDays: number;
  onLookbackDaysChange: (days: number) => void;
  paymentKeywords: string[];
  onPaymentKeywordsChange: (keywords: string[]) => void;
  onDisconnected: () => void;
}

function parseKeywords(value: string): string[] {
  return value
    .split(',')
    .map((k) => k.trim())
    .filter((k) => k !== '');
}
```

```ts
export function SettingsPanel({
  api,
  baseUrl,
  lookbackDays,
  onLookbackDaysChange,
  paymentKeywords,
  onPaymentKeywordsChange,
  onDisconnected,
}: SettingsPanelProps) {
  const [disconnecting, setDisconnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lookbackDraft, setLookbackDraft] = useState(String(lookbackDays));
  const [keywordsDraft, setKeywordsDraft] = useState(paymentKeywords.join(', '));
```

Add a Save handler alongside `handleSaveLookback`:

```ts
  function handleSaveKeywords() {
    onPaymentKeywordsChange(parseKeywords(keywordsDraft));
  }
```

Add a new `Card` section (matching the "Sync" card's structure) after the
existing lookback-window `Card`:

```tsx
      <Card>
        <CardHeader>
          <CardTitle>Payment detection</CardTitle>
          <CardDescription>
            A card credit whose payee or comment contains any of these (case-insensitive) is
            staged as a possible bill payment for reconciliation into a transfer.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="payment-keywords">Payment keywords (comma-separated)</Label>
            <div className="flex items-center gap-2">
              <Input
                id="payment-keywords"
                className="w-full"
                value={keywordsDraft}
                onChange={(e) => setKeywordsDraft(e.target.value)}
              />
              <Button
                onClick={handleSaveKeywords}
                disabled={parseKeywords(keywordsDraft).join(',') === paymentKeywords.join(',')}
              >
                Save keywords
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
```

Finally, thread the new prop through `src/pages/SyncPage.tsx`: add a
`persistPaymentKeywords` function mirroring `persistLookbackDays`, and pass
`paymentKeywords`/`onPaymentKeywordsChange` into `<SettingsPanel>`:

```ts
  async function persistPaymentKeywords(paymentKeywords: string[]) {
    if (!config) return;
    const previous = config;
    const next = { ...config, paymentKeywords };
    setConfig(next);
    try {
      await writeConfig(api, next);
    } catch (err) {
      setConfig(previous);
      setError(err instanceof Error ? err.message : String(err));
    }
  }
```

```tsx
            <SettingsPanel
              api={api}
              baseUrl={config.baseUrl}
              lookbackDays={config.lookbackDays}
              onLookbackDaysChange={persistLookbackDays}
              paymentKeywords={config.paymentKeywords}
              onPaymentKeywordsChange={persistPaymentKeywords}
              onDisconnected={loadConfig}
            />
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test -- SettingsPanel.test.tsx`
Expected: PASS

- [ ] **Step 5: Run the full suite and type-check**

Run: `pnpm type-check && pnpm test`
Expected: PASS — this also confirms `SyncPage.tsx`'s new `SettingsPanel`
usage type-checks against the extended props.

- [ ] **Step 6: Commit**

```bash
git add src/components/SettingsPanel.tsx src/components/SettingsPanel.test.tsx src/pages/SyncPage.tsx
git commit -m "feat: make payment-detection keywords user-editable in Settings"
```

---

## Final verification

- [ ] Run `pnpm type-check && pnpm test` once more from a clean state and confirm everything passes.
- [ ] Manually smoke-test via `pnpm bundle` and reinstalling the zip on the live instance used during the design spike: map a credit-card account and its paying cash account, trigger a sync with a payment-like transaction, and confirm it stages, reconciles, and reclassifies as expected. (This repeats the earlier probe's steps but against the real feature, not the throwaway panel.)
