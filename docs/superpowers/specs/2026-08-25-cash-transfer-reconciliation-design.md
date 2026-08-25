# Extend Payment/Transfer Reconciliation to Cash-to-Cash Transfers — Design

No GitHub issue exists yet for this — one should be created (per this repo's
task-management convention) before the implementation plan is written.

## Problem

Credit-card bill payments already get detected and reclassified as
`TRANSFER_IN`/`TRANSFER_OUT` pairs (see
[2026-08-14-reclassify-credit-card-payments-design.md](./2026-08-14-reclassify-credit-card-payments-design.md)).
A regular transfer between two mapped cash accounts (e.g. checking →
savings) imports today as an ordinary `DEPOSIT` on one side and `WITHDRAWAL`
on the other — money-in/money-out noise instead of an internal transfer,
the same problem the card-payment work already solved for one specific pair
of account types.

## Design

The existing staging + reconciliation pipeline (`activities.ts`,
`reconciliation.ts`, `staging.ts`) is generalized to be symmetric across
both flows, rather than building a second parallel pipeline. `mode ===
'CASH'` mappings whose Wealthfolio `accountType !== 'CREDIT_CARD'` already
define exactly the pool of "cash accounts" (`cashAccountIdsFrom`,
`config.ts`), so no new account-type concept is needed — only the
detection/matching logic needs to stop assuming one side is always a card.

### 1. Config

Add `transferKeywords: string[]` to `SyncConfig` (`config.ts`), following
the exact pattern already used for `paymentKeywords`: defaults via
`DEFAULT_TRANSFER_KEYWORDS = ['TRANSFER', 'XFER']`, spread over
`emptyConfig()`'s defaults on read so pre-existing configs load without
migration, edited in `SettingsPanel.tsx` via a second draft-input-plus-Save
control mirroring "Payment detection." `'ONLINE TRANSFER'` is deliberately
left out of the default — it's a substring of `'TRANSFER'` and would never
add coverage the shorter keyword doesn't already give; a user who needs a
narrower or additional term can add it via the existing UI.

### 2. Staged candidate shape

`StagedCandidate` (`staging.ts`) is generalized from card-specific field
names to generic ones, plus a new discriminator:

```ts
interface StagedCandidate {
  sfTransactionId: string;
  inflowAccountId: string;        // was cardAccountId
  inflowActivityId: string | null; // was cardActivityId
  inflowActivityType: 'CREDIT' | 'DEPOSIT'; // NEW
  amount: string;
  postedDate: string;
  comment: string;
  status: 'pending' | 'ambiguous';
  candidateWithdrawalIds: string[];
}
```

`inflowActivityType` records which Wealthfolio activity type the staged
transaction imported as — `'CREDIT'` for a card-side bill payment, `'DEPOSIT'`
for a cash-to-cash transfer's receiving leg — so the reconciliation pass
knows what to search for without re-deriving it from the account's type.

**Back-compat:** this is a breaking shape change for any candidate already
persisted in `storage['staging']` by a prior version. No migration is
written. A stale record simply fails to resolve (its renamed fields read as
`undefined`) and falls out via the existing `EXPIRY_DAYS` (7-day) sweep —
the same "give up gracefully" path already used for a genuinely unmatched
candidate. Given staged candidates are transient by design and this is
pre-1.0, a few pre-existing pending candidates expiring unresolved is an
acceptable one-time cost.

### 3. Detection (`activities.ts`)

`detectCandidate` takes an added `inflowActivityType` parameter and stamps
it onto the returned candidate. In `syncCashAccount`, the branch that
today only fires `accountType === 'CREDIT_CARD'` becomes symmetric between
the two inflow types instead of an on/off switch:

- `accountType === 'CREDIT_CARD'` → scan inflow (non-negative-amount)
  transactions against `paymentKeywords`, tag `'CREDIT'` — unchanged
  behavior.
- otherwise (any `CASH`-mode, non-card mapping) → scan inflow transactions
  against `transferKeywords`, tag `'DEPOSIT'`.

`WITHDRAWAL`-side transactions are never scanned for keywords on either
branch (unchanged) — only the receiving leg's payee/comment is checked, so
a transfer can only ever be staged once, from the destination account.

`syncCashAccount`, `syncOne`, and `runSync` each gain a threaded
`transferKeywords` parameter alongside the existing `paymentKeywords`.

### 4. Reconciliation (`reconciliation.ts`)

- `findCardActivity` → `findInflowActivity`: searches
  `candidate.inflowActivityType` instead of a hardcoded `'CREDIT'`, so it
  resolves a `DEPOSIT` candidate's real activity the same way it already
  resolves a `CREDIT` one.
- `withdrawalMatches` gains one additional filter: exclude any withdrawal
  whose `accountId === candidate.inflowAccountId`. This stops a transfer's
  destination account from ever matching a withdrawal sitting in that same
  account. It's a no-op for the existing card-payment flow, since a card
  account was never included in the cash-accounts withdrawal pool to begin
  with (`cashAccountIdsFrom` already excludes `CREDIT_CARD`) — so this
  doesn't change card-payment matching behavior.
- Everything else is unchanged and shared by both flows: the once-per-run
  shared withdrawal-pool fetch, `MATCH_WINDOW_DAYS`/`EXPIRY_DAYS`,
  `claimedWithdrawalIds` (still tracked across *all* candidates in a run
  regardless of type, so a card-payment candidate and a cash-transfer
  candidate can't both claim the same withdrawal), `resolved`/`ambiguous`/
  `expired` counting, and `reclassifyPair` (still `TRANSFER_IN` on the
  inflow leg / `TRANSFER_OUT` on the withdrawal leg, independent of whether
  the inflow leg was `CREDIT` or `DEPOSIT`).

### 5. UI

- `SettingsPanel.tsx` / `SyncPage.tsx`: second keyword box, "Transfer
  detection," wired through a new `persistTransferKeywords` following the
  existing `persistPaymentKeywords` pattern exactly.
- `StagedTransactionsList.tsx`: add a "Type" column, derived — not stored —
  from `candidate.inflowActivityType` (`'CREDIT'` → "Card payment",
  `'DEPOSIT'` → "Cash transfer"), so a list mixing both kinds of candidate
  stays legible. No new field or config needed for this; it's a pure
  display-side mapping in the component.

### 6. Testing

Existing detection/reconciliation test suites gain cases mirroring the
card-payment ones, but for two `CASH`-mode, non-card accounts:

- a `DEPOSIT` on one cash account matching `transferKeywords` stages
  correctly, tagged `inflowActivityType: 'DEPOSIT'`
- it resolves against a same-amount, in-window `WITHDRAWAL` on a
  *different* cash account (auto-reclassifies both legs)
- a same-amount, in-window `WITHDRAWAL` sitting in the *same* account as
  the candidate's `inflowAccountId` is excluded from its match pool, even
  though amount/date alone would otherwise qualify
- 2+ matching withdrawals across different cash accounts still produce
  `status: 'ambiguous'` with all candidate ids populated, same as today
- card-payment behavior is unchanged: existing card-payment test cases
  continue to pass against the generalized code paths.

## Implementation checklist

- [ ] `transferKeywords` config field + Settings tab UI
      (`SettingsPanel.tsx`/`SyncPage.tsx`)
- [ ] `StagedCandidate` field rename + `inflowActivityType` addition
      (`staging.ts`)
- [ ] Detection: symmetric branch in `syncCashAccount` for `CASH`-mode
      non-card accounts, tagging `'DEPOSIT'` candidates from
      `transferKeywords` (`activities.ts`)
- [ ] `findCardActivity` → `findInflowActivity`, searching by
      `inflowActivityType` (`reconciliation.ts`)
- [ ] `withdrawalMatches`: exclude same-account withdrawals
      (`reconciliation.ts`)
- [ ] Thread `transferKeywords` through `syncCashAccount`/`syncOne`/`runSync`
- [ ] "Type" column in `StagedTransactionsList.tsx`
- [ ] Test coverage for cash-to-cash detection, matching, same-account
      exclusion, and ambiguity, alongside regression coverage confirming
      card-payment behavior is unchanged
