# Extend Payment/Transfer Reconciliation to Cash-to-Cash Transfers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generalize the existing credit-card-payment staging/reconciliation pipeline so it also detects and reclassifies regular transfers between two mapped cash accounts (checking → savings, etc.) as `TRANSFER_IN`/`TRANSFER_OUT` pairs, the same way it already does for card bill payments.

**Architecture:** `StagedCandidate`'s card-specific fields (`cardAccountId`/`cardActivityId`) become generic (`inflowAccountId`/`inflowActivityId`) plus a new `inflowActivityType: 'CREDIT' | 'DEPOSIT'` discriminator. Detection in `syncCashAccount` becomes symmetric: a `CREDIT_CARD` account's inflow is checked against `paymentKeywords` (unchanged, tagged `'CREDIT'`); any other `CASH`-mode account's inflow is checked against a new `transferKeywords` list (tagged `'DEPOSIT'`). Reconciliation resolves whichever activity type the candidate carries instead of a hardcoded `'CREDIT'`, and excludes a candidate's own account from its withdrawal-match pool (a no-op for the card flow, required for the cash-transfer flow so a transfer's destination account can't match a withdrawal sitting in that same account). One staging store, one reconciliation engine, one UI table serve both flows.

**Tech Stack:** TypeScript, React, Vitest, `@wealthfolio/addon-sdk` `HostAPI`.

**Spec:** `docs/superpowers/specs/2026-08-25-cash-transfer-reconciliation-design.md`

## Global Constraints

- No hardcoded numeric values beyond named, commented constants tied to an explicit requirement (this repo's existing `MATCH_WINDOW_DAYS`/`EXPIRY_DAYS`/`OVERLAP_DAYS` precedent) — never a fabricated score or threshold.
- Never parse money amounts to `Number`/`float` for comparison or arithmetic — use `normalise()` (string-based), matching this repo's existing convention.
- Every caught error is logged via `api.logger.error` with account/candidate context, or re-thrown — never swallowed silently.
- Detection only ever scans the *inflow* (non-negative-amount) leg of a transaction for keywords — the withdrawal/outflow leg is never itself turned into a candidate, on either the card-payment or the cash-transfer path.
- `withdrawalMatches` must exclude any withdrawal whose `accountId` equals the candidate's own `inflowAccountId` — a no-op for the card-payment flow (a card account is never in the cash-accounts withdrawal pool to begin with), but required for the cash-transfer flow so a transfer's destination account can never match a withdrawal sitting in that same account.
- `StagedCandidate`'s renamed fields (`inflowAccountId`/`inflowActivityId`/`inflowActivityType`) get no migration for already-persisted staging records — a stale record from a prior version simply fails to resolve and expires via the existing 7-day (`EXPIRY_DAYS`) sweep, same as any other genuinely-unmatched candidate.
- `DEFAULT_TRANSFER_KEYWORDS = ['TRANSFER', 'XFER']` — `'ONLINE TRANSFER'` is deliberately omitted from the default (it's a substring of `'TRANSFER'` and would add no coverage); a user who needs it can add it via the Settings UI.
- Reclassifying a matched pair remains one `activities.saveMany({ updates: [inflowUpdate, withdrawalUpdate] })` call, never two sequential `activities.update()` calls — existing invariant from the card-payment feature, unchanged.
- Per-candidate and per-account failures stay isolated: one bad match/API error must not block any other candidate or account.

---

## File Structure

No new files — this generalizes an existing pipeline in place.

**Modified files:**
- `src/lib/storage/config.ts` — add `transferKeywords: string[]` + `DEFAULT_TRANSFER_KEYWORDS`.
- `src/lib/storage/config.test.ts` — add the new field to every shape assertion.
- `src/lib/sync/run.test.ts` — add `transferKeywords` to every inline/typed config literal (Task 1); rename a `writeStaging` fixture and add a cash-transfer integration test (Task 2).
- `src/components/SetupCard.tsx` — add `transferKeywords: DEFAULT_TRANSFER_KEYWORDS` to its `writeConfig` call.
- `src/lib/storage/staging.ts` — rename `StagedCandidate`'s card-specific fields to generic ones; add `InflowActivityType`.
- `src/lib/storage/staging.test.ts` — update the candidate fixture for the new shape.
- `src/lib/sync/activities.ts` — `detectCandidate` takes an `inflowActivityType` param; `syncCashAccount` takes a `transferKeywords` param and detects `DEPOSIT` candidates on non-card `CASH` accounts.
- `src/lib/sync/activities.test.ts` — update every `syncCashAccount`/`detectCandidate` call site; add cash-transfer detection tests.
- `src/lib/sync/reconciliation.ts` — `findCardActivity` → `findInflowActivity` (searches by `candidate.inflowActivityType`); `withdrawalMatches` excludes the candidate's own account.
- `src/lib/sync/reconciliation.test.ts` — rename fixtures/call sites; add cash-transfer and same-account-exclusion tests.
- `src/lib/sync/run.ts` — thread `transferKeywords` through `syncOne`/`runSync`.
- `src/components/StagedTransactionsList.test.tsx` — rename fixture fields (Task 2); add a "Type" column test (Task 4).
- `src/pages/SyncPage.sync.test.tsx` — rename two raw staging fixtures.
- `manifest.json` — reword the `activities` permission's `purpose` string to mention cash transfers.
- `src/components/SettingsPanel.tsx` — add a "Transfer detection" keyword editor alongside the existing "Payment detection" one.
- `src/components/SettingsPanel.test.tsx` — add coverage for the new editor; update the disconnect test's expected config shape.
- `src/pages/SyncPage.tsx` — add `persistTransferKeywords`, wire the new prop into `SettingsPanel`.

---

### Task 1: Config — `transferKeywords` field

**Files:**
- Modify: `src/lib/storage/config.ts`
- Modify: `src/lib/sync/run.test.ts` (five pre-existing config object literals need the new required field — see Step 3b)
- Modify: `src/components/SetupCard.tsx`
- Test: `src/lib/storage/config.test.ts`

**Interfaces:**
- Produces: `SyncConfig.transferKeywords: string[]`; `DEFAULT_TRANSFER_KEYWORDS: string[]` exported from `src/lib/storage/config.ts`.

**Pre-flight note:** `transferKeywords` is a *required* field on `SyncConfig`. Any object literal passed where a `SyncConfig` is expected — whether explicitly typed or not — is structurally checked by TypeScript against the full interface. `grep -n "paymentKeywords:" src/lib/sync/run.test.ts` finds five such literals in that one file (lines ~28, ~288, ~390, ~427, ~472); all five need `transferKeywords` added or `pnpm type-check` breaks for every later task to trip over.

- [ ] **Step 1: Write the failing tests**

Replace the entire contents of `src/lib/storage/config.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { createMockHost } from '../../test/mockHost';
import {
  DEFAULT_LOOKBACK_DAYS,
  DEFAULT_PAYMENT_KEYWORDS,
  DEFAULT_TRANSFER_KEYWORDS,
  cashAccountIdsFrom,
  readConfig,
  writeConfig,
  type AccountMapping,
} from './config';

describe('config', () => {
  it('returns an empty config when nothing is stored', async () => {
    const host = createMockHost();
    expect(await readConfig(host.api)).toEqual({
      baseUrl: null,
      mappings: [],
      lookbackDays: DEFAULT_LOOKBACK_DAYS,
      paymentKeywords: DEFAULT_PAYMENT_KEYWORDS,
      transferKeywords: DEFAULT_TRANSFER_KEYWORDS,
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
      transferKeywords: ['TRANSFER'],
    };
    await writeConfig(host.api, config);
    expect(await readConfig(host.api)).toEqual(config);
  });

  it('defaults lookbackDays, paymentKeywords, and transferKeywords for a config written before those fields existed', async () => {
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
      transferKeywords: DEFAULT_TRANSFER_KEYWORDS,
    });
  });

  it('never stores credentials in the base URL', async () => {
    const host = createMockHost();
    await writeConfig(host.api, {
      baseUrl: 'https://bridge.simplefin.org/simplefin',
      mappings: [],
      lookbackDays: DEFAULT_LOOKBACK_DAYS,
      paymentKeywords: DEFAULT_PAYMENT_KEYWORDS,
      transferKeywords: DEFAULT_TRANSFER_KEYWORDS,
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
      transferKeywords: DEFAULT_TRANSFER_KEYWORDS,
    });
    expect(host.api.logger.error).toHaveBeenCalled();
  });
});

describe('cashAccountIdsFrom', () => {
  const mapping = (over: Partial<AccountMapping> = {}): AccountMapping => ({
    sfAccountId: 'ACT-1',
    wfAccountId: 'WF-1',
    mode: 'CASH',
    sfAccountName: 'Account',
    orgName: 'Bank',
    ...over,
  });

  it('excludes a CREDIT_CARD account even when its mode is CASH', () => {
    const mappings = [
      mapping({ wfAccountId: 'WF-CARD' }),
      mapping({ wfAccountId: 'WF-CASH' }),
    ];
    const accountTypeOf = (id: string) => (id === 'WF-CARD' ? ('CREDIT_CARD' as const) : ('CASH' as const));

    expect(cashAccountIdsFrom(mappings, accountTypeOf)).toEqual(['WF-CASH']);
  });

  it('excludes a HOLDINGS-mode mapping regardless of account type', () => {
    const mappings = [mapping({ wfAccountId: 'WF-BROKERAGE', mode: 'HOLDINGS' })];

    expect(cashAccountIdsFrom(mappings, () => 'CASH' as const)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test -- config.test.ts`
Expected: FAIL — `DEFAULT_TRANSFER_KEYWORDS` is not exported, and the shape assertions are missing `transferKeywords` from the actual `emptyConfig()`.

- [ ] **Step 3: Implement**

Replace the entire contents of `src/lib/storage/config.ts`:

```ts
import type { AccountType, HostAPI } from '@wealthfolio/addon-sdk';
import { storageKey } from './keys';

/** How a mapped SimpleFIN account is pushed into Wealthfolio. */
export type SyncMode = 'CASH' | 'HOLDINGS';

export interface AccountMapping {
  sfAccountId: string;
  wfAccountId: string;
  mode: SyncMode;
  /** Cached for display when the Bridge is unreachable. */
  sfAccountName: string;
  orgName: string;
}

export interface SyncConfig {
  /** Credential-free SimpleFIN base URL. Credentials live in `secrets`. */
  baseUrl: string | null;
  mappings: AccountMapping[];
  /** Floor on how far back a sync ever asks the Bridge for, in days. */
  lookbackDays: number;
  /** Case-insensitive substrings checked against a card credit's payee/comment to detect a bill payment. */
  paymentKeywords: string[];
  /** Case-insensitive substrings checked against a cash-account deposit's payee/comment to detect an internal transfer. */
  transferKeywords: string[];
}

/** One statement cycle — enough to seed a new account without an unbounded first pull. */
export const DEFAULT_LOOKBACK_DAYS = 30;

/** Common bill-payment phrasing across US/Canadian card issuers. */
export const DEFAULT_PAYMENT_KEYWORDS = ['PAYMENT', 'AUTOPAY', 'THANK YOU'];

/** Common internal-transfer phrasing between a user's own cash accounts. */
export const DEFAULT_TRANSFER_KEYWORDS = ['TRANSFER', 'XFER'];

const CONFIG_KEY = storageKey('config');

export function emptyConfig(): SyncConfig {
  return {
    baseUrl: null,
    mappings: [],
    lookbackDays: DEFAULT_LOOKBACK_DAYS,
    paymentKeywords: DEFAULT_PAYMENT_KEYWORDS,
    transferKeywords: DEFAULT_TRANSFER_KEYWORDS,
  };
}

export async function readConfig(api: HostAPI): Promise<SyncConfig> {
  const raw = await api.storage.get(CONFIG_KEY);
  if (!raw) return emptyConfig();

  try {
    const parsed = JSON.parse(raw) as Partial<SyncConfig>;
    // `lookbackDays`/`paymentKeywords`/`transferKeywords` were each added
    // after configs already existed in the wild; default them for anything
    // written by an older version of the addon.
    return { ...emptyConfig(), ...parsed };
  } catch (error) {
    // Returning empty sends the user back to setup, which is recoverable;
    // throwing here would leave the addon permanently unopenable.
    api.logger.error(`[simplefin] corrupt config, falling back to empty: ${String(error)}`);
    return emptyConfig();
  }
}

export async function writeConfig(api: HostAPI, config: SyncConfig): Promise<void> {
  await api.storage.set(CONFIG_KEY, JSON.stringify(config));
}

/**
 * `mode` is the sync mode ('CASH' | 'HOLDINGS'), not the Wealthfolio account
 * type — `defaultModeFor` assigns 'CASH' to any account with no holdings,
 * which is exactly what a mapped credit-card account gets. Reconciliation's
 * withdrawal search must never include a card's own account (every purchase
 * on it is a WITHDRAWAL), so this also excludes CREDIT_CARD accounts. The
 * same pool doubles as the eligible-destination set for cash-to-cash
 * transfer detection — every account here is a non-card `CASH`-mode mapping.
 */
export function cashAccountIdsFrom(
  mappings: AccountMapping[],
  accountTypeOf: (wfAccountId: string) => AccountType | undefined,
): string[] {
  return mappings
    .filter((m) => m.mode === 'CASH' && accountTypeOf(m.wfAccountId) !== 'CREDIT_CARD')
    .map((m) => m.wfAccountId);
}
```

- [ ] **Step 3b: Fix the five pre-existing config literals in `run.test.ts`, and `SetupCard.tsx`**

In `src/lib/sync/run.test.ts`, add `transferKeywords: ['TRANSFER', 'XFER'],` immediately after the `paymentKeywords: [...]` line in each of these five object literals (find each via `grep -n "paymentKeywords:" src/lib/sync/run.test.ts`):

1. The top-level `const config: SyncConfig = {...}` (used by most `describe('runSync', ...)` tests).
2. `cardConfig` inside `it('never treats a mapped credit-card account as a cash account for withdrawal matching', ...)`.
3. `cardConfig` inside `it('persists a detected candidate and reconciles it against an existing withdrawal in the same run', ...)`.
4. The inline config object passed directly to `runSync(...)` inside `it('keeps an unresolved candidate staged for the next run', ...)`.
5. `const backfillConfig: SyncConfig = {...}` inside `describe('runSync opening-balance backfill', ...)`.

None of these five tests assert on `transferKeywords` itself — this step exists purely so the file still type-checks (each literal is passed somewhere a `SyncConfig` is expected, so TypeScript structurally requires the field even where there's no explicit `: SyncConfig` annotation).

In `src/components/SetupCard.tsx`, add `DEFAULT_TRANSFER_KEYWORDS` to the import and to the `writeConfig` call:

```ts
import { DEFAULT_LOOKBACK_DAYS, DEFAULT_PAYMENT_KEYWORDS, DEFAULT_TRANSFER_KEYWORDS, writeConfig } from '../lib/storage/config';
```

```ts
      await writeConfig(api, {
        baseUrl,
        mappings: [],
        lookbackDays: DEFAULT_LOOKBACK_DAYS,
        paymentKeywords: DEFAULT_PAYMENT_KEYWORDS,
        transferKeywords: DEFAULT_TRANSFER_KEYWORDS,
      });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm type-check && pnpm test -- config.test.ts run.test.ts`
Expected: PASS — the `type-check` here specifically confirms Step 3b closed every gap; a green `config.test.ts` alone would not have caught it.

- [ ] **Step 5: Commit**

```bash
git add src/lib/storage/config.ts src/lib/storage/config.test.ts src/lib/sync/run.test.ts src/components/SetupCard.tsx
git commit -m "feat: add configurable transfer keywords to SyncConfig"
```

---

### Task 2: Generalize staged-candidate detection and reconciliation for cash-to-cash transfers

**Files:**
- Modify: `src/lib/storage/staging.ts`
- Modify: `src/lib/storage/staging.test.ts`
- Modify: `src/lib/sync/activities.ts`
- Modify: `src/lib/sync/activities.test.ts`
- Modify: `src/lib/sync/reconciliation.ts`
- Modify: `src/lib/sync/reconciliation.test.ts`
- Modify: `src/lib/sync/run.ts`
- Modify: `src/lib/sync/run.test.ts`
- Modify: `src/components/StagedTransactionsList.test.tsx`
- Modify: `src/pages/SyncPage.sync.test.tsx`
- Modify: `manifest.json`

**Interfaces:**
- Consumes: `SyncConfig.transferKeywords` (Task 1).
- Produces: `StagedCandidate.inflowAccountId: string`, `.inflowActivityId: string | null`, `.inflowActivityType: InflowActivityType` (`'CREDIT' | 'DEPOSIT'`), replacing `cardAccountId`/`cardActivityId` — from `src/lib/storage/staging.ts`. `detectCandidate(txn, mapping, keywords, inflowActivityType): StagedCandidate | null` and `syncCashAccount(api, mapping, sfAccount, watermark, accountType, paymentKeywords, transferKeywords)` — from `src/lib/sync/activities.ts`. `findInflowActivity(api, candidate): Promise<ActivityDetails | null>` (replaces `findCardActivity`) — from `src/lib/sync/reconciliation.ts`. `syncOne`'s and `runSync`'s calls thread `transferKeywords` alongside `paymentKeywords`.

This is one atomic task rather than several smaller ones: renaming a shared type's fields and generalizing its one producer (`activities.ts`) and one consumer (`reconciliation.ts`) can't be split into independently-compiling slices — a reviewer can't sensibly approve "staging.ts renamed" while rejecting "reconciliation.ts still uses the old names," since that combination doesn't type-check.

- [ ] **Step 1: Write the failing tests**

Replace the entire contents of `src/lib/storage/staging.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { createMockHost } from '../../test/mockHost';
import { readStaging, writeStaging, type StagedCandidate } from './staging';

const candidate = (over: Partial<StagedCandidate> = {}): StagedCandidate => ({
  sfTransactionId: 'TXN-1',
  inflowAccountId: 'WF-CARD',
  inflowActivityId: null,
  inflowActivityType: 'CREDIT',
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

  it('round-trips the staged candidate list, including a cash-transfer (DEPOSIT) candidate', async () => {
    const host = createMockHost();
    const candidates = [
      candidate(),
      candidate({
        sfTransactionId: 'TXN-2',
        inflowActivityType: 'DEPOSIT',
        status: 'ambiguous',
        candidateWithdrawalIds: ['A-1', 'A-2'],
      }),
    ];
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

Replace the entire contents of `src/lib/sync/activities.test.ts`:

```ts
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
    );
    expect(candidate).toEqual({
      sfTransactionId: 'TXN-9',
      inflowAccountId: 'WF-1',
      inflowActivityId: null,
      inflowActivityType: 'CREDIT',
      amount: '75.00',
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
    );
    expect(candidate).toEqual({
      sfTransactionId: 'TXN-10',
      inflowAccountId: 'WF-1',
      inflowActivityId: null,
      inflowActivityType: 'DEPOSIT',
      amount: '200.00',
      postedDate: '2025-08-06',
      comment: 'Online Transfer From Checking',
      status: 'pending',
      candidateWithdrawalIds: [],
    });
  });

  it('returns null for a transaction that does not match any keyword', () => {
    expect(detectCandidate(txn({ payee: 'Amazon Refund' }) as never, mapping, ['PAYMENT'], 'CREDIT')).toBeNull();
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
```

Replace the entire contents of `src/lib/sync/reconciliation.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import type { ActivityDetails } from '@wealthfolio/addon-sdk';
import { createMockHost } from '../../test/mockHost';
import type { StagedCandidate } from '../storage/staging';
import { describeWithdrawals, findInflowActivity, resolveAmbiguous, runReconciliation } from './reconciliation';

const NOW = 1754438400 + 5 * 86_400; // 5 days after the fixtures' posted date

const candidate = (over: Partial<StagedCandidate> = {}): StagedCandidate => ({
  sfTransactionId: 'TXN-1',
  inflowAccountId: 'WF-CARD',
  inflowActivityId: null,
  inflowActivityType: 'CREDIT',
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

    const { candidates, summary } = await runReconciliation(host.api, [candidate()], ['WF-CASH'], NOW);

    expect(candidates).toHaveLength(0);
    expect(summary.resolved).toBe(1);
    expect(host.api.activities.saveMany).toHaveBeenCalledWith({
      updates: [
        expect.objectContaining({ id: 'CARD-ACT-1', activityType: 'TRANSFER_IN' }),
        expect.objectContaining({ id: 'CASH-ACT-1', activityType: 'TRANSFER_OUT' }),
      ],
    });
  });

  it('resolves a cash-to-cash transfer candidate (DEPOSIT inflow) the same way', async () => {
    const host = createMockHost();
    const depositActivity = cardActivity({
      id: 'DEPOSIT-ACT-1',
      accountId: 'WF-CASH-B',
      activityType: 'DEPOSIT',
      comment: 'Online Transfer From Checking',
    });
    const sourceWithdrawal = withdrawalActivity({ accountId: 'WF-CASH-A', comment: 'Online Transfer To Savings' });

    host.api.activities.search = vi.fn(async (_p: number, _s: number, filters: { activityTypes: string }) => {
      if (filters.activityTypes === 'DEPOSIT') return { data: [depositActivity], meta: { totalRowCount: 1 } };
      return { data: [sourceWithdrawal], meta: { totalRowCount: 1 } };
    }) as never;

    const transferCandidate = candidate({
      inflowAccountId: 'WF-CASH-B',
      inflowActivityType: 'DEPOSIT',
      comment: 'Online Transfer From Checking',
    });

    const { candidates, summary } = await runReconciliation(
      host.api,
      [transferCandidate],
      ['WF-CASH-A', 'WF-CASH-B'],
      NOW,
    );

    expect(candidates).toHaveLength(0);
    expect(summary.resolved).toBe(1);
    expect(host.api.activities.saveMany).toHaveBeenCalledWith({
      updates: [
        expect.objectContaining({ id: 'DEPOSIT-ACT-1', activityType: 'TRANSFER_IN' }),
        expect.objectContaining({ id: 'CASH-ACT-1', activityType: 'TRANSFER_OUT' }),
      ],
    });
  });

  it("excludes a same-amount, in-window withdrawal sitting in the candidate's own inflow account", async () => {
    const host = createMockHost();
    const depositActivity = cardActivity({
      id: 'DEPOSIT-ACT-1',
      accountId: 'WF-CASH-B',
      activityType: 'DEPOSIT',
    });
    // This withdrawal is in the SAME account the transfer landed in (WF-CASH-B) —
    // it must never be treated as this candidate's own source leg.
    const selfAccountWithdrawal = withdrawalActivity({ id: 'SELF-WD', accountId: 'WF-CASH-B' });

    host.api.activities.search = vi.fn(async (_p: number, _s: number, filters: { activityTypes: string }) => {
      if (filters.activityTypes === 'DEPOSIT') return { data: [depositActivity], meta: { totalRowCount: 1 } };
      return { data: [selfAccountWithdrawal], meta: { totalRowCount: 1 } };
    }) as never;

    const transferCandidate = candidate({ inflowAccountId: 'WF-CASH-B', inflowActivityType: 'DEPOSIT' });

    const { candidates } = await runReconciliation(host.api, [transferCandidate], ['WF-CASH-B'], NOW);

    expect(candidates[0].status).toBe('pending');
    expect(host.api.activities.saveMany).not.toHaveBeenCalled();
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
    expect(candidates[0].inflowActivityId).toBe('CARD-ACT-1');
    expect(summary.resolved).toBe(0);
    expect(host.api.activities.saveMany).not.toHaveBeenCalled();
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
    expect(host.api.activities.saveMany).not.toHaveBeenCalled();
  });

  it('excludes a withdrawal outside the 3-day match window', async () => {
    const host = createMockHost();
    host.api.activities.search = vi.fn(async (_p: number, _s: number, filters: { activityTypes: string }) => {
      if (filters.activityTypes === 'CREDIT') return { data: [cardActivity()], meta: { totalRowCount: 1 } };
      return {
        // `date` is typed as `Date`, but the live host actually serialises it as an ISO string —
        // this cast preserves that real runtime shape while satisfying the SDK's fixture typing.
        data: [withdrawalActivity({ date: '2025-07-30T00:00:00+00:00' as unknown as Date })], // 7 days before the card credit
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

    const bad = candidate({ sfTransactionId: 'TXN-BAD', inflowAccountId: 'WF-CARD-BAD' });
    const good = candidate({ sfTransactionId: 'TXN-GOOD' });

    const { candidates, summary } = await runReconciliation(host.api, [bad, good], ['WF-CASH'], NOW);

    expect(summary.resolved).toBe(1);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].sfTransactionId).toBe('TXN-BAD');
    expect(host.api.logger.error).toHaveBeenCalledWith(expect.stringContaining('TXN-BAD'));
  });

  it('re-stages the candidate when saveMany resolves with per-item errors instead of throwing', async () => {
    const host = createMockHost();
    host.api.activities.search = vi.fn(async (_p: number, _s: number, filters: { activityTypes: string }) => {
      if (filters.activityTypes === 'CREDIT') return { data: [cardActivity()], meta: { totalRowCount: 1 } };
      return { data: [withdrawalActivity()], meta: { totalRowCount: 1 } };
    }) as never;
    host.api.activities.saveMany = vi.fn(async () => ({
      created: [],
      updated: [],
      deleted: [],
      createdMappings: [],
      errors: [{ id: 'CARD-ACT-1', action: 'update', message: 'row locked' }],
    })) as never;

    const { candidates, summary } = await runReconciliation(host.api, [candidate()], ['WF-CASH'], NOW);

    expect(summary.resolved).toBe(0);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].sfTransactionId).toBe('TXN-1');
    expect(host.api.logger.error).toHaveBeenCalledWith(expect.stringContaining('TXN-1'));
  });

  it('fetches the withdrawal search once per run rather than once per candidate', async () => {
    const host = createMockHost();
    let withdrawalSearchCalls = 0;
    host.api.activities.search = vi.fn(async (_p: number, _s: number, filters: { activityTypes: string }) => {
      if (filters.activityTypes === 'CREDIT') return { data: [cardActivity()], meta: { totalRowCount: 1 } };
      withdrawalSearchCalls += 1;
      return { data: [], meta: { totalRowCount: 0 } };
    }) as never;

    const candidates = [
      candidate({ sfTransactionId: 'TXN-1' }),
      candidate({ sfTransactionId: 'TXN-2' }),
      candidate({ sfTransactionId: 'TXN-3' }),
    ];
    await runReconciliation(host.api, candidates, ['WF-CASH'], NOW);

    expect(withdrawalSearchCalls).toBe(1);
  });

  it('does not let a second same-amount candidate double-claim a withdrawal already claimed this run', async () => {
    const host = createMockHost();
    host.api.activities.search = vi.fn(async (_p: number, _s: number, filters: { activityTypes: string }) => {
      if (filters.activityTypes === 'CREDIT') {
        return { data: [cardActivity(), cardActivity({ id: 'CARD-ACT-2' })], meta: { totalRowCount: 2 } };
      }
      // Only one real withdrawal exists to match against both candidates.
      return { data: [withdrawalActivity()], meta: { totalRowCount: 1 } };
    }) as never;

    const first = candidate({ sfTransactionId: 'TXN-1', inflowActivityId: 'CARD-ACT-1' });
    const second = candidate({ sfTransactionId: 'TXN-2', inflowActivityId: 'CARD-ACT-2' });

    const { candidates, summary } = await runReconciliation(host.api, [first, second], ['WF-CASH'], NOW);

    expect(summary.resolved).toBe(1);
    expect(host.api.activities.saveMany).toHaveBeenCalledTimes(1);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].sfTransactionId).toBe('TXN-2');
    expect(candidates[0].status).toBe('pending');
  });

  it('skips the withdrawal search and leaves candidates pending when cashAccountIds is empty', async () => {
    const host = createMockHost();
    host.api.activities.search = vi.fn(async (_p: number, _s: number, filters: { activityTypes: string }) => {
      if (filters.activityTypes === 'CREDIT') return { data: [cardActivity()], meta: { totalRowCount: 1 } };
      throw new Error('should never search for WITHDRAWAL when cashAccountIds is empty');
    }) as never;

    const { candidates, summary } = await runReconciliation(host.api, [candidate()], [], NOW);

    expect(host.api.activities.search).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ activityTypes: 'WITHDRAWAL' }),
      expect.anything(),
    );
    expect(candidates).toHaveLength(1);
    expect(candidates[0].status).toBe('pending');
    expect(summary.resolved).toBe(0);
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

describe('findInflowActivity', () => {
  it('resolves by accountId/amount/date/comment when inflowActivityId is unknown', async () => {
    const host = createMockHost();
    host.api.activities.search = vi.fn(async () => ({ data: [cardActivity()], meta: { totalRowCount: 1 } })) as never;

    const found = await findInflowActivity(host.api, candidate());
    expect(found?.id).toBe('CARD-ACT-1');
  });

  it('resolves by id directly once inflowActivityId is known', async () => {
    const host = createMockHost();
    host.api.activities.search = vi.fn(async () => ({
      data: [cardActivity(), cardActivity({ id: 'OTHER', comment: 'different' })],
      meta: { totalRowCount: 2 },
    })) as never;

    const found = await findInflowActivity(host.api, candidate({ inflowActivityId: 'OTHER' }));
    expect(found?.id).toBe('OTHER');
  });

  it("searches by the candidate's own inflowActivityType, not a hardcoded CREDIT", async () => {
    const host = createMockHost();
    let requestedType: string | undefined;
    host.api.activities.search = vi.fn(async (_p: number, _s: number, filters: { activityTypes: string }) => {
      requestedType = filters.activityTypes;
      return { data: [], meta: { totalRowCount: 0 } };
    }) as never;

    await findInflowActivity(host.api, candidate({ inflowActivityType: 'DEPOSIT' }));
    expect(requestedType).toBe('DEPOSIT');
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
  it('reclassifies the chosen withdrawal and the resolved inflow activity', async () => {
    const host = createMockHost();
    host.api.activities.search = vi.fn(async (_p: number, _s: number, filters: { activityTypes: string }) => {
      if (filters.activityTypes === 'CREDIT') return { data: [cardActivity()], meta: { totalRowCount: 1 } };
      return { data: [withdrawalActivity(), withdrawalActivity({ id: 'OTHER' })], meta: { totalRowCount: 2 } };
    }) as never;

    await resolveAmbiguous(
      host.api,
      candidate({ status: 'ambiguous', inflowActivityId: 'CARD-ACT-1', candidateWithdrawalIds: ['CASH-ACT-1', 'OTHER'] }),
      ['WF-CASH'],
      'CASH-ACT-1',
    );

    expect(host.api.activities.saveMany).toHaveBeenCalledWith({
      updates: [
        expect.objectContaining({ id: 'CARD-ACT-1', activityType: 'TRANSFER_IN' }),
        expect.objectContaining({ id: 'CASH-ACT-1', activityType: 'TRANSFER_OUT' }),
      ],
    });
  });

  it('throws if the chosen withdrawal can no longer be found', async () => {
    const host = createMockHost();
    host.api.activities.search = vi.fn(async (_p: number, _s: number, filters: { activityTypes: string }) => {
      if (filters.activityTypes === 'CREDIT') return { data: [cardActivity()], meta: { totalRowCount: 1 } };
      return { data: [], meta: { totalRowCount: 0 } };
    }) as never;

    await expect(
      resolveAmbiguous(host.api, candidate({ inflowActivityId: 'CARD-ACT-1' }), ['WF-CASH'], 'GONE'),
    ).rejects.toThrow(/GONE/);
  });
});
```

In `src/lib/sync/run.test.ts`, rename the `writeStaging` fixture inside `it('keeps an unresolved candidate staged for the next run', ...)`:

```ts
    await writeStaging(host.api, [
      {
        sfTransactionId: 'TXN-OLD',
        inflowAccountId: 'ACT-CARD',
        inflowActivityId: null,
        inflowActivityType: 'CREDIT',
        amount: '50.00',
        postedDate: new Date().toISOString().slice(0, 10),
        comment: 'Online Payment Thank You',
        status: 'pending',
        candidateWithdrawalIds: [],
      },
    ]);
```

Then add this new test to `src/lib/sync/run.test.ts`, right after `it('persists a detected candidate and reconciles it against an existing withdrawal in the same run', ...)`:

```ts
  it('detects a cash-to-cash transfer candidate and reconciles it against an existing withdrawal in another cash account, in the same run', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1754438400 * 1000 + 2 * 86_400_000));

    const host = createMockHost();
    host.respond(/\/accounts/, {
      body: JSON.stringify({
        errors: [],
        accounts: [
          {
            org: { name: 'Bank B' },
            id: 'ACT-SAVINGS',
            name: 'Savings',
            currency: 'USD',
            balance: '0.00',
            'balance-date': 1754438400,
            transactions: [
              { id: 'TXN-XFER', posted: 1754438400, amount: '200.00', description: 'Online Transfer From Checking' },
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
      if (filters.activityTypes === 'DEPOSIT') {
        return {
          data: [
            {
              id: 'DEPOSIT-ACT-1',
              accountId: 'WF-SAVINGS',
              activityType: 'DEPOSIT',
              date: '2025-08-06T00:00:00+00:00',
              amount: '200',
              currency: 'USD',
              comment: 'Online Transfer From Checking',
            },
          ],
          meta: { totalRowCount: 1 },
        };
      }
      return {
        data: [
          {
            id: 'CHECKING-WD-1',
            accountId: 'WF-CHECKING',
            activityType: 'WITHDRAWAL',
            date: '2025-08-05T00:00:00+00:00',
            amount: '200',
            currency: 'USD',
            comment: 'Online Transfer To Savings',
          },
        ],
        meta: { totalRowCount: 1 },
      };
    }) as never;
    host.api.activities.saveMany = vi.fn(async (req) => ({
      created: [],
      updated: req.updates ?? [],
      deleted: [],
      createdMappings: [],
      errors: [],
    })) as never;
    host.api.accounts.getAll = vi.fn(async () => [
      { id: 'WF-SAVINGS', accountType: 'CASH', balance: 0 },
      { id: 'WF-CHECKING', accountType: 'CASH', balance: 0 },
    ] as never);

    const transferConfig = {
      baseUrl: 'https://bridge.simplefin.org/simplefin',
      mappings: [
        { sfAccountId: 'ACT-SAVINGS', wfAccountId: 'WF-SAVINGS', mode: 'CASH' as const, sfAccountName: 'Savings', orgName: 'Bank B' },
        { sfAccountId: 'ACT-CHECKING', wfAccountId: 'WF-CHECKING', mode: 'CASH' as const, sfAccountName: 'Checking', orgName: 'Bank A' },
      ],
      lookbackDays: 30,
      paymentKeywords: ['PAYMENT'],
      transferKeywords: ['TRANSFER'],
    };

    await runSync(host.api, transferConfig);

    expect(host.api.activities.saveMany).toHaveBeenCalledWith({
      updates: [
        expect.objectContaining({ id: 'DEPOSIT-ACT-1', activityType: 'TRANSFER_IN' }),
        expect.objectContaining({ id: 'CHECKING-WD-1', activityType: 'TRANSFER_OUT' }),
      ],
    });
    expect(await readStaging(host.api)).toEqual([]);
  });
```

In `src/components/StagedTransactionsList.test.tsx`, replace the two top-level fixtures:

```ts
const pending: StagedCandidate = {
  sfTransactionId: 'TXN-1',
  inflowAccountId: 'WF-CARD',
  inflowActivityId: null,
  inflowActivityType: 'CREDIT',
  amount: '50.00',
  postedDate: '2026-08-01',
  comment: 'Online Payment Thank You',
  status: 'pending',
  candidateWithdrawalIds: [],
};

const ambiguous: StagedCandidate = {
  sfTransactionId: 'TXN-2',
  inflowAccountId: 'WF-CARD',
  inflowActivityId: 'CARD-ACT-2',
  inflowActivityType: 'CREDIT',
  amount: '80.00',
  postedDate: '2026-08-02',
  comment: 'Autopay',
  status: 'ambiguous',
  candidateWithdrawalIds: ['CASH-A', 'CASH-B'],
};
```

In `src/pages/SyncPage.sync.test.tsx`, in `it('renders staged candidates under the Staged tab', ...)`, replace the staged fixture:

```ts
    await host.api.storage.set(
      'simplefin.staging',
      JSON.stringify([
        {
          sfTransactionId: 'TXN-1',
          inflowAccountId: 'WF-CARD',
          inflowActivityId: null,
          inflowActivityType: 'CREDIT',
          amount: '50.00',
          postedDate: '2026-08-01',
          comment: 'Online Payment Thank You',
          status: 'pending',
          candidateWithdrawalIds: [],
        },
      ]),
    );
```

And in `it('refreshes the Staged tab after a completed sync, since it stays mounted across tab switches', ...)`, replace the staged fixture:

```ts
    await host.api.storage.set(
      'simplefin.staging',
      JSON.stringify([
        {
          sfTransactionId: 'TXN-2',
          inflowAccountId: 'WF-CARD',
          inflowActivityId: null,
          inflowActivityType: 'CREDIT',
          amount: '25.00',
          postedDate: new Date().toISOString().slice(0, 10),
          comment: 'Autopay',
          status: 'pending',
          candidateWithdrawalIds: [],
        },
      ]),
    );
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test -- staging.test.ts activities.test.ts reconciliation.test.ts`
Expected: FAIL — `StagedCandidate` still has `cardAccountId`/`cardActivityId`, `detectCandidate`/`syncCashAccount` don't yet accept the new params, and `findInflowActivity` doesn't exist.

- [ ] **Step 3: Implement**

Replace the entire contents of `src/lib/storage/staging.ts`:

```ts
import type { HostAPI } from '@wealthfolio/addon-sdk';
import { storageKey } from './keys';

export type CandidateStatus = 'pending' | 'ambiguous';

/** Which Wealthfolio activity type the staged inflow leg imported as. */
export type InflowActivityType = 'CREDIT' | 'DEPOSIT';

export interface StagedCandidate {
  /** Identity: the SimpleFIN transaction id of the inflow leg (card CREDIT or cash-transfer DEPOSIT). */
  sfTransactionId: string;
  /** Wealthfolio account id the inflow leg landed on. */
  inflowAccountId: string;
  /** Real Wealthfolio activity id — null until a reconciliation pass resolves it via search(). */
  inflowActivityId: string | null;
  /** 'CREDIT' for a credit-card bill payment; 'DEPOSIT' for a cash-to-cash transfer. */
  inflowActivityType: InflowActivityType;
  amount: string;
  /** ISO date (YYYY-MM-DD) the inflow leg posted. */
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

Replace the entire contents of `src/lib/sync/activities.ts`:

```ts
import type { AccountType, ActivityImport, HostAPI } from '@wealthfolio/addon-sdk';
import type { SfAccount, SfTransaction } from '../simplefin/parse';
import type { AccountMapping } from '../storage/config';
import type { InflowActivityType, StagedCandidate } from '../storage/staging';
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

/** Case-insensitive substring match against a configured keyword list. */
export function isPaymentCandidate(text: string, keywords: string[]): boolean {
  const upper = text.toUpperCase();
  return keywords.some((keyword) => keyword.trim() !== '' && upper.includes(keyword.toUpperCase()));
}

/**
 * An inflow transaction (`CREDIT` on a credit-card account, or `DEPOSIT` on a
 * plain cash account) whose payee/comment looks like a bill payment or an
 * internal transfer becomes a staged candidate for TRANSFER_IN/OUT
 * reconciliation (see `./reconciliation.ts`). Returns null for anything that
 * doesn't match — normal purchases, paychecks, and unrelated credits are left
 * untouched.
 */
export function detectCandidate(
  txn: SfTransaction,
  mapping: AccountMapping,
  keywords: string[],
  inflowActivityType: InflowActivityType,
): StagedCandidate | null {
  const text = txn.payee || txn.description;
  if (!isPaymentCandidate(text, keywords)) return null;

  return {
    sfTransactionId: txn.id,
    inflowAccountId: mapping.wfAccountId,
    inflowActivityId: null,
    inflowActivityType,
    amount: txn.amount.trim().replace(/^-/, ''),
    postedDate: isoDate(txn.posted),
    comment: text,
    status: 'pending',
    candidateWithdrawalIds: [],
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
  transferKeywords: string[],
): Promise<{
  result: CashSyncCounts;
  watermark: Watermark;
  candidates: StagedCandidate[];
  importedTxns: SfTransaction[];
}> {
  // Pending transactions are excluded from v1: their id and amount can both
  // change once posted, which would push a row we could never reconcile.
  const candidates = sfAccount.transactions.filter((t) => !t.pending && shouldPush(watermark, t));

  if (candidates.length === 0) {
    return {
      result: { imported: 0, skipped: 0, duplicates: 0 },
      watermark,
      candidates: [],
      importedTxns: [],
    };
  }

  const rows = candidates.map((t) => toActivityImport(t, mapping, sfAccount.currency, accountType));
  let checked;
  try {
    checked = await api.activities.checkImport(rows);
  } catch (error) {
    // A rejection here means the host rejected the request itself (e.g. a
    // required field the addon-sdk types don't yet reflect) rather than
    // flagging individual rows — log the payload so the mismatch is visible.
    api.logger.error(
      `[simplefin] activities.checkImport rejected ${rows.length} row(s) for ` +
        `${mapping.sfAccountName}: ${JSON.stringify(rows)}`,
    );
    throw error;
  }

  // checkImport annotates each row. Host-detected duplicates are a secondary
  // guard behind our own watermark; we never force-import over them.
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
    // Rows duplicating an activity Wealthfolio already holds (`duplicateOfId`)
    // are genuinely present on the other side, so the watermark may advance
    // over them — otherwise every run re-checks the same rows forever. Rows
    // flagged only by `duplicateOfLineNumber` duplicate another row in *this*
    // batch, which was itself never imported here, so those must not advance.
    const advanced = advanceWatermark(
      watermark,
      candidates.filter((_, i) => checked[i].duplicateOfId),
    );
    return {
      result: { imported: 0, skipped, duplicates },
      watermark: advanced,
      candidates: [],
      importedTxns: [],
    };
  }

  let outcome;
  try {
    outcome = await api.activities.import(importable);
  } catch (error) {
    // `checkImport` marked these rows valid, so a rejection here means the
    // host's import-time validation caught something checkImport didn't —
    // log the exact payload so the failing field is visible next run instead
    // of just the bare HTTP status text.
    api.logger.error(
      `[simplefin] activities.import rejected ${importable.length} row(s) for ` +
        `${mapping.sfAccountName}: ${JSON.stringify(importable)}`,
    );
    throw error;
  }

  // Only an inflow (money landing on the account) is ever scanned for
  // keywords — the withdrawal/purchase leg is never turned into a candidate
  // itself, only matched against one. Which keyword list and inflow activity
  // type applies depends on what kind of account this is: a credit-card
  // CREDIT is checked against paymentKeywords, a plain cash account's DEPOSIT
  // against transferKeywords.
  const inflowTxns = importableTxns.filter((t) => !t.amount.trim().startsWith('-'));
  const stagedCandidates =
    accountType === 'CREDIT_CARD'
      ? inflowTxns
          .map((t) => detectCandidate(t, mapping, paymentKeywords, 'CREDIT'))
          .filter((c): c is StagedCandidate => c !== null)
      : inflowTxns
          .map((t) => detectCandidate(t, mapping, transferKeywords, 'DEPOSIT'))
          .filter((c): c is StagedCandidate => c !== null);

  return {
    result: { imported: outcome.summary.imported, skipped, duplicates },
    // Only advance over what was actually accepted — if the import throws, this
    // line is never reached and the watermark stays put, so the next run retries.
    watermark: advanceWatermark(watermark, importableTxns),
    candidates: stagedCandidates,
    importedTxns: importableTxns,
  };
}
```

Replace the entire contents of `src/lib/sync/reconciliation.ts`:

```ts
import type { ActivityDetails, ActivityUpdate, HostAPI } from '@wealthfolio/addon-sdk';
import type { StagedCandidate } from '../storage/staging';
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
    if (nowSeconds - postedSeconds > EXPIRY_DAYS * SECONDS_PER_DAY) {
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
```

In `src/lib/sync/run.ts`, thread `transferKeywords` alongside `paymentKeywords` through `syncOne`'s signature and its `syncCashAccount` call:

```ts
async function syncOne(
  api: HostAPI,
  baseUrl: string,
  mapping: AccountMapping,
  sfAccount: SfAccount | undefined,
  wfBalances: Map<string, string>,
  wfAccountTypes: Map<string, AccountType>,
  paymentKeywords: string[],
  transferKeywords: string[],
): Promise<{ accountResult: AccountRunResult; candidates: StagedCandidate[] }> {
```

```ts
    const {
      result,
      watermark: next,
      candidates,
      importedTxns,
    } = await syncCashAccount(
      api,
      mapping,
      syncSfAccount,
      watermark,
      wfAccountTypes.get(mapping.wfAccountId) ?? 'CASH',
      paymentKeywords,
      transferKeywords,
    );
```

And in `runSync`'s per-mapping loop:

```ts
  for (const mapping of config.mappings) {
    const { accountResult, candidates } = await syncOne(
      api,
      config.baseUrl,
      mapping,
      bySfId.get(mapping.sfAccountId),
      wfBalances,
      wfAccountTypes,
      config.paymentKeywords,
      config.transferKeywords,
    );
    results.push(accountResult);
    detectedCandidates.push(...candidates);
  }
```

Finally, in `manifest.json`, reword the `activities` permission's purpose to mention cash transfers:

```json
      "purpose": "Import cash transactions fetched from SimpleFIN, and reconcile credit-card payments and cash-to-cash transfers into linked transfers."
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test -- staging.test.ts activities.test.ts reconciliation.test.ts run.test.ts`
Expected: PASS

- [ ] **Step 5: Run the full suite and type-check**

Run: `pnpm type-check && pnpm test`
Expected: PASS — this confirms no other file (`StagedTransactionsList.test.tsx`, `SyncPage.sync.test.tsx`, or otherwise) still refers to the old `cardAccountId`/`cardActivityId`/`findCardActivity` names.

- [ ] **Step 6: Commit**

```bash
git add src/lib/storage/staging.ts src/lib/storage/staging.test.ts src/lib/sync/activities.ts src/lib/sync/activities.test.ts src/lib/sync/reconciliation.ts src/lib/sync/reconciliation.test.ts src/lib/sync/run.ts src/lib/sync/run.test.ts src/components/StagedTransactionsList.test.tsx src/pages/SyncPage.sync.test.tsx manifest.json
git commit -m "feat: detect and reconcile cash-to-cash transfers alongside credit-card payments

Generalizes StagedCandidate and the reconciliation pipeline (previously
card-CREDIT-only) to also stage a plain cash account's keyword-matched
DEPOSIT as a transfer candidate, matched against a withdrawal in a
different mapped cash account and reclassified the same way."
```

---

### Task 3: Settings UI — transfer keyword editor

**Files:**
- Modify: `src/components/SettingsPanel.tsx`
- Modify: `src/components/SettingsPanel.test.tsx`
- Modify: `src/pages/SyncPage.tsx`

**Interfaces:**
- Consumes: `SyncConfig.transferKeywords` (Task 1).
- Produces: `SettingsPanelProps.transferKeywords: string[]` / `.onTransferKeywordsChange: (keywords: string[]) => void`.

- [ ] **Step 1: Write the failing tests**

Replace the entire contents of `src/components/SettingsPanel.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { createMockHost } from '../test/mockHost';
import { AUTH_SECRET_KEY } from '../lib/simplefin/client';
import { DEFAULT_LOOKBACK_DAYS, DEFAULT_PAYMENT_KEYWORDS, DEFAULT_TRANSFER_KEYWORDS } from '../lib/storage/config';
import { SettingsPanel } from './SettingsPanel';

const BASE_URL = 'https://bridge.simplefin.org/simplefin';

function renderPanel(overrides: Partial<Parameters<typeof SettingsPanel>[0]> = {}) {
  const host = createMockHost();
  const onDisconnected = vi.fn();
  const onLookbackDaysChange = vi.fn();
  const onPaymentKeywordsChange = vi.fn();
  const onTransferKeywordsChange = vi.fn();
  render(
    <SettingsPanel
      api={host.api}
      baseUrl={BASE_URL}
      lookbackDays={DEFAULT_LOOKBACK_DAYS}
      onLookbackDaysChange={onLookbackDaysChange}
      paymentKeywords={DEFAULT_PAYMENT_KEYWORDS}
      onPaymentKeywordsChange={onPaymentKeywordsChange}
      transferKeywords={DEFAULT_TRANSFER_KEYWORDS}
      onTransferKeywordsChange={onTransferKeywordsChange}
      onDisconnected={onDisconnected}
      {...overrides}
    />,
  );
  return { host, onDisconnected, onLookbackDaysChange, onPaymentKeywordsChange, onTransferKeywordsChange };
}

describe('SettingsPanel', () => {
  it('shows the connected Bridge URL with the path masked', () => {
    renderPanel();

    expect(screen.getByText('https://bridge.simplefin.org/••••••')).toBeInTheDocument();
  });

  it('requires confirmation before disconnecting', async () => {
    const { host, onDisconnected } = renderPanel();
    host.secrets.set(AUTH_SECRET_KEY, 'secret');

    await userEvent.click(screen.getByRole('button', { name: /disconnect/i }));

    expect(onDisconnected).not.toHaveBeenCalled();
    expect(host.secrets.get(AUTH_SECRET_KEY)).toBe('secret');
  });

  it('clears the stored credential and config, then notifies the parent on confirm', async () => {
    const { host, onDisconnected } = renderPanel();
    host.secrets.set(AUTH_SECRET_KEY, 'secret');
    host.storage.set('simplefin.config', JSON.stringify({ baseUrl: BASE_URL, mappings: [] }));

    await userEvent.click(screen.getByRole('button', { name: /disconnect/i }));
    await userEvent.click(await screen.findByRole('button', { name: /yes, disconnect/i }));

    expect(host.secrets.get(AUTH_SECRET_KEY)).toBeUndefined();
    expect(JSON.parse(host.storage.get('simplefin.config') as string)).toEqual({
      baseUrl: null,
      mappings: [],
      lookbackDays: DEFAULT_LOOKBACK_DAYS,
      paymentKeywords: DEFAULT_PAYMENT_KEYWORDS,
      transferKeywords: DEFAULT_TRANSFER_KEYWORDS,
    });
    expect(onDisconnected).toHaveBeenCalled();
  });

  it('surfaces a disconnect failure instead of silently notifying the parent', async () => {
    const { host, onDisconnected } = renderPanel();
    host.api.secrets.delete = vi.fn(async () => {
      throw new Error('keyring unavailable');
    });

    await userEvent.click(screen.getByRole('button', { name: /disconnect/i }));
    await userEvent.click(await screen.findByRole('button', { name: /yes, disconnect/i }));

    expect(await screen.findByText(/keyring unavailable/i)).toBeInTheDocument();
    expect(onDisconnected).not.toHaveBeenCalled();
  });

  it('disables Save until the lookback window actually changes to a valid value', async () => {
    renderPanel({ lookbackDays: 30 });
    const input = screen.getByLabelText(/lookback window/i);
    const save = screen.getByRole('button', { name: /^save$/i });

    expect(save).toBeDisabled();

    await userEvent.clear(input);
    await userEvent.type(input, '0');
    expect(save).toBeDisabled();

    await userEvent.clear(input);
    await userEvent.type(input, '60');
    expect(save).toBeEnabled();
  });

  it('saves the parsed lookback window as a number', async () => {
    const { onLookbackDaysChange } = renderPanel({ lookbackDays: 30 });
    const input = screen.getByLabelText(/lookback window/i);

    await userEvent.clear(input);
    await userEvent.type(input, '90');
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }));

    expect(onLookbackDaysChange).toHaveBeenCalledWith(90);
  });

  it('shows the current payment keywords as a comma-separated list', () => {
    renderPanel({ paymentKeywords: ['PAYMENT', 'AUTOPAY'] });
    expect(screen.getByLabelText(/payment keywords/i)).toHaveValue('PAYMENT, AUTOPAY');
  });

  it('disables the payment Save button until the keyword list actually changes', async () => {
    renderPanel({ paymentKeywords: ['PAYMENT'] });
    const input = screen.getByLabelText(/payment keywords/i);
    const save = screen.getByRole('button', { name: /^save keywords$/i });

    expect(save).toBeDisabled();
    await userEvent.type(input, ', AUTOPAY');
    expect(save).toBeEnabled();
  });

  it('saves the payment comma-separated input as a trimmed keyword array', async () => {
    const { onPaymentKeywordsChange } = renderPanel({ paymentKeywords: ['PAYMENT'] });
    const input = screen.getByLabelText(/payment keywords/i);

    await userEvent.clear(input);
    await userEvent.type(input, ' payment ,  autopay ,thank you ');
    await userEvent.click(screen.getByRole('button', { name: /^save keywords$/i }));

    expect(onPaymentKeywordsChange).toHaveBeenCalledWith(['payment', 'autopay', 'thank you']);
  });

  it('shows the current transfer keywords as a comma-separated list', () => {
    renderPanel({ transferKeywords: ['TRANSFER', 'XFER'] });
    expect(screen.getByLabelText(/transfer keywords/i)).toHaveValue('TRANSFER, XFER');
  });

  it('disables the transfer Save button until the keyword list actually changes', async () => {
    renderPanel({ transferKeywords: ['TRANSFER'] });
    const input = screen.getByLabelText(/transfer keywords/i);
    const save = screen.getByRole('button', { name: /^save transfer keywords$/i });

    expect(save).toBeDisabled();
    await userEvent.type(input, ', XFER');
    expect(save).toBeEnabled();
  });

  it('saves the transfer comma-separated input as a trimmed keyword array', async () => {
    const { onTransferKeywordsChange } = renderPanel({ transferKeywords: ['TRANSFER'] });
    const input = screen.getByLabelText(/transfer keywords/i);

    await userEvent.clear(input);
    await userEvent.type(input, ' transfer ,  xfer ');
    await userEvent.click(screen.getByRole('button', { name: /^save transfer keywords$/i }));

    expect(onTransferKeywordsChange).toHaveBeenCalledWith(['transfer', 'xfer']);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test -- SettingsPanel.test.tsx`
Expected: FAIL — `SettingsPanel` doesn't yet accept `transferKeywords`/`onTransferKeywordsChange`, and there's no "Transfer keywords" input.

- [ ] **Step 3: Implement**

Replace the entire contents of `src/components/SettingsPanel.tsx`:

```tsx
import type { HostAPI } from '@wealthfolio/addon-sdk';
import {
  Alert,
  AlertDescription,
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Label,
} from '@wealthfolio/ui';
import { useState } from 'react';
import { AUTH_SECRET_KEY } from '../lib/simplefin/client';
import { maskBaseUrl } from '../lib/simplefin/url';
import { emptyConfig, writeConfig } from '../lib/storage/config';

export interface SettingsPanelProps {
  api: HostAPI;
  baseUrl: string;
  lookbackDays: number;
  onLookbackDaysChange: (days: number) => void;
  paymentKeywords: string[];
  onPaymentKeywordsChange: (keywords: string[]) => void;
  transferKeywords: string[];
  onTransferKeywordsChange: (keywords: string[]) => void;
  onDisconnected: () => void;
}

function isValidLookback(value: string): boolean {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1;
}

function parseKeywords(value: string): string[] {
  return value
    .split(',')
    .map((k) => k.trim())
    .filter((k) => k !== '');
}

export function SettingsPanel({
  api,
  baseUrl,
  lookbackDays,
  onLookbackDaysChange,
  paymentKeywords,
  onPaymentKeywordsChange,
  transferKeywords,
  onTransferKeywordsChange,
  onDisconnected,
}: SettingsPanelProps) {
  const [disconnecting, setDisconnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lookbackDraft, setLookbackDraft] = useState(String(lookbackDays));
  const [paymentKeywordsDraft, setPaymentKeywordsDraft] = useState(paymentKeywords.join(', '));
  const [transferKeywordsDraft, setTransferKeywordsDraft] = useState(transferKeywords.join(', '));

  async function handleDisconnect() {
    setError(null);
    setDisconnecting(true);
    try {
      await api.secrets.delete(AUTH_SECRET_KEY);
      await writeConfig(api, emptyConfig());
      onDisconnected();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setDisconnecting(false);
    }
  }

  function handleSaveLookback() {
    onLookbackDaysChange(Number(lookbackDraft));
  }

  function handleSavePaymentKeywords() {
    onPaymentKeywordsChange(parseKeywords(paymentKeywordsDraft));
  }

  function handleSaveTransferKeywords() {
    onTransferKeywordsChange(parseKeywords(transferKeywordsDraft));
  }

  return (
    <div className="space-y-4">
      {error && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <Card>
        <CardHeader>
          <CardTitle>Connection</CardTitle>
          <CardDescription>Manage the SimpleFIN Bridge connection for this addon.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label>SimpleFIN Bridge URL</Label>
            <p className="text-muted-foreground text-sm">{maskBaseUrl(baseUrl)}</p>
          </div>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="destructive" disabled={disconnecting}>
                {disconnecting ? 'Disconnecting…' : 'Disconnect'}
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Disconnect SimpleFIN Bridge?</AlertDialogTitle>
                <AlertDialogDescription>
                  This clears the stored SimpleFIN credentials and all account mappings.
                  You&apos;ll need to reconnect with a new setup token to sync again.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction onClick={handleDisconnect}>Yes, disconnect</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Sync</CardTitle>
          <CardDescription>
            Every sync reaches back at least this many days, so a newly mapped account gets its
            history even if your other accounts are already caught up.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="lookback-days">Lookback window (days)</Label>
            <div className="flex items-center gap-2">
              <Input
                id="lookback-days"
                type="number"
                min={1}
                step={1}
                className="w-24"
                value={lookbackDraft}
                onChange={(e) => setLookbackDraft(e.target.value)}
              />
              <Button
                onClick={handleSaveLookback}
                disabled={
                  !isValidLookback(lookbackDraft) || Number(lookbackDraft) === lookbackDays
                }
              >
                Save
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
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
                value={paymentKeywordsDraft}
                onChange={(e) => setPaymentKeywordsDraft(e.target.value)}
              />
              <Button
                onClick={handleSavePaymentKeywords}
                disabled={parseKeywords(paymentKeywordsDraft).join(',') === paymentKeywords.join(',')}
              >
                Save keywords
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Transfer detection</CardTitle>
          <CardDescription>
            A deposit into a mapped cash account whose payee or comment contains any of these
            (case-insensitive) is staged as a possible internal transfer for reconciliation against
            a matching withdrawal in another mapped cash account.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="transfer-keywords">Transfer keywords (comma-separated)</Label>
            <div className="flex items-center gap-2">
              <Input
                id="transfer-keywords"
                className="w-full"
                value={transferKeywordsDraft}
                onChange={(e) => setTransferKeywordsDraft(e.target.value)}
              />
              <Button
                onClick={handleSaveTransferKeywords}
                disabled={parseKeywords(transferKeywordsDraft).join(',') === transferKeywords.join(',')}
              >
                Save transfer keywords
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
```

In `src/pages/SyncPage.tsx`, add `persistTransferKeywords` right after `persistPaymentKeywords`:

```ts
  async function persistTransferKeywords(transferKeywords: string[]) {
    if (!config) return;
    const previous = config;
    const next = { ...config, transferKeywords };
    setConfig(next);
    try {
      await writeConfig(api, next);
    } catch (err) {
      setConfig(previous);
      setError(err instanceof Error ? err.message : String(err));
    }
  }
```

And wire the new prop into the `<SettingsPanel>` call inside the `settings` tab:

```tsx
            <SettingsPanel
              api={api}
              baseUrl={config.baseUrl}
              lookbackDays={config.lookbackDays}
              onLookbackDaysChange={persistLookbackDays}
              paymentKeywords={config.paymentKeywords}
              onPaymentKeywordsChange={persistPaymentKeywords}
              transferKeywords={config.transferKeywords}
              onTransferKeywordsChange={persistTransferKeywords}
              onDisconnected={loadConfig}
            />
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test -- SettingsPanel.test.tsx`
Expected: PASS

- [ ] **Step 5: Run the full suite and type-check**

Run: `pnpm type-check && pnpm test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/components/SettingsPanel.tsx src/components/SettingsPanel.test.tsx src/pages/SyncPage.tsx
git commit -m "feat: add a Transfer detection keyword editor to Settings"
```

---

### Task 4: Staged Transactions UI — distinguish card payments from cash transfers

**Files:**
- Modify: `src/components/StagedTransactionsList.tsx`
- Modify: `src/components/StagedTransactionsList.test.tsx`

**Interfaces:**
- Consumes: `StagedCandidate.inflowActivityType` (Task 2).

- [ ] **Step 1: Write the failing test**

Append this test to `src/components/StagedTransactionsList.test.tsx` (after the existing `'lists pending and ambiguous candidates with their amount and comment'` test):

```tsx
  it('labels a card-payment candidate and a cash-transfer candidate distinctly', async () => {
    const host = createMockHost();
    const transfer: StagedCandidate = {
      sfTransactionId: 'TXN-3',
      inflowAccountId: 'WF-SAVINGS',
      inflowActivityId: null,
      inflowActivityType: 'DEPOSIT',
      amount: '200.00',
      postedDate: '2026-08-03',
      comment: 'Online Transfer From Checking',
      status: 'pending',
      candidateWithdrawalIds: [],
    };
    await writeStaging(host.api, [pending, transfer]);

    render(<StagedTransactionsList api={host.api} cashAccountIds={['WF-CASH']} />);

    const cardRow = (await screen.findByText('Online Payment Thank You')).closest('tr') as HTMLElement;
    expect(within(cardRow).getByText('Card payment')).toBeInTheDocument();

    const transferRow = (await screen.findByText('Online Transfer From Checking')).closest('tr') as HTMLElement;
    expect(within(transferRow).getByText('Cash transfer')).toBeInTheDocument();
  });
```

(`within` is already imported at the top of this file from `@testing-library/react`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- StagedTransactionsList.test.tsx`
Expected: FAIL — there is no "Card payment"/"Cash transfer" text rendered anywhere yet.

- [ ] **Step 3: Implement**

In `src/components/StagedTransactionsList.tsx`, add a label helper after the imports (before `StagedTransactionsListProps`):

```tsx
function candidateTypeLabel(candidate: StagedCandidate): string {
  return candidate.inflowActivityType === 'DEPOSIT' ? 'Cash transfer' : 'Card payment';
}
```

Add a "Type" column to the header row:

```tsx
        <TableHeader>
          <TableRow>
            <TableHead className={compactHeadClassName}>Amount</TableHead>
            <TableHead className={compactHeadClassName}>Comment</TableHead>
            <TableHead className={compactHeadClassName}>Type</TableHead>
            <TableHead className={compactHeadClassName}>Status</TableHead>
            <TableHead className={compactHeadClassName}>Action</TableHead>
          </TableRow>
        </TableHeader>
```

And a matching cell in the body row:

```tsx
            <TableRow key={candidate.sfTransactionId}>
              <TableCell className={compactCellClassName}>{candidate.amount}</TableCell>
              <TableCell className={compactCellClassName}>{candidate.comment}</TableCell>
              <TableCell className={compactCellClassName}>{candidateTypeLabel(candidate)}</TableCell>
              <TableCell className={compactCellClassName}>{candidate.status}</TableCell>
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- StagedTransactionsList.test.tsx`
Expected: PASS

- [ ] **Step 5: Run the full suite and type-check**

Run: `pnpm type-check && pnpm test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/components/StagedTransactionsList.tsx src/components/StagedTransactionsList.test.tsx
git commit -m "feat: label staged candidates as Card payment or Cash transfer in the Staged tab"
```

---

## After all tasks

Close out the branch per this repo's workflow: `Closes #65` in the PR body (feature branch → `dev`), and verify the GitHub issue actually closes rather than assuming the merge handled it (this repo's default branch is `main`, so GitHub's native closing-keyword behavior does not fire on a merge into `dev` — see CLAUDE.md rule 7).
