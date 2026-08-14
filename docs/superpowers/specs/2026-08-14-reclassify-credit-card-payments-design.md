# Reclassify Credit-Card Payments as TRANSFER_IN/TRANSFER_OUT — Design

Implements [#50](https://github.com/christancho/simplefin-wealthfolio-addon/issues/50).

## Problem

Credit-card payments currently import as an ordinary money-in transaction on
the card account and `WITHDRAWAL` on the paying cash account. Wealthfolio has
a dedicated pair of types for this — `TRANSFER_OUT` (cash leg) / `TRANSFER_IN`
(card leg) — so these should show up as internal transfers, not
income/spending.

## Verified against a live host

Before finalizing this design, a throwaway probe (built into a temporary
"Probe" tab on the Sync page, removed before implementation) exercised the
real `activities` API against a live self-hosted instance. Findings that
shape the design below:

- **`accountType` is reliable.** `accounts.getAll()` consistently reports
  `accountType: 'CREDIT_CARD'` for mapped card accounts.
- **`DEPOSIT` is rejected outright on a `CREDIT_CARD` account.**
  `checkImport()`/`import()` return `isValid: false` with
  `"DEPOSIT activities are not supported for credit card accounts"` — this
  is a request-level validation rule, not a soft warning. This means the
  **already-shipped** `toActivityImport()` (`src/lib/sync/activities.ts`) is
  currently producing an invalid row for every real credit-card payment or
  credit; those rows silently land in `skipped` on every sync of a mapped
  card account. Fixing this is now part of this design (see below) rather
  than a separate issue, since detection depends on it anyway.
- **`CREDIT` is accepted** on a `CREDIT_CARD` account (`isValid: true`,
  imports successfully). This is the correct type for money landing on a
  credit-card account, and the type detection should watch instead of
  `DEPOSIT`.
- **`activities.update()` is durable.** After reclassifying a pair to
  `TRANSFER_IN`/`TRANSFER_OUT`, a fresh read-only `checkImport()` call and a
  follow-up `search()` both still show the reclassified type with
  `isUserModified: true`. Nothing reverted it.
- **`sourceGroupId` is not persisted by `update()`.** It was included in the
  update payload but came back `null` in the response and in every later
  read. The "visually link the pair via `sourceGroupId`" nice-to-have from
  the original issue does not work and is dropped from this design.
- **`import()`'s response is not a source of real activity ids.** It echoes
  back the submitted `ActivityImport` objects (including their synthetic
  preview ids), not the persisted `Activity` records. Real ids must come
  from a subsequent `search()`.
- **`activities.search()` paginates from page `0`,** not `1` — passing `1`
  as the first page silently returns `data: []` with a nonzero
  `meta.totalRowCount`, which reads as "no results" if not caught.
- **`search()`'s `searchKeyword` does not match `comment`/`notes`.** It
  appears scoped to asset/symbol name. This is not a blocker — the
  reconciliation pass never depended on keyword search — but rules out using
  it as a shortcut for finding a specific row; filtering must happen
  client-side over `{ accountIds, activityTypes }` results.
- **`ActivityImport.symbol` is required by the host** despite being optional
  in the shipped SDK types (already fixed in `toActivityImport()` for the
  existing cash-sync path; noted here since the reconciliation pass's own
  `ActivityUpdate` calls don't need it, but any new `ActivityImport` calls
  would).

## Design

### 1. Fix: emit `CREDIT` instead of `DEPOSIT` for credit-card accounts

In `toActivityImport()` (`src/lib/sync/activities.ts`), when
`mapping`'s destination account is a `CREDIT_CARD` account, an inflow
(positive-amount) transaction becomes `CREDIT` instead of `DEPOSIT`. This
requires threading the destination account's `accountType` into
`toActivityImport()` (currently it only receives `mapping` and `currency`) —
`syncCashAccount` already has access to Wealthfolio account data via the
existing balance-mismatch lookup path, so this is a matter of passing the
`accountType` through rather than a new fetch.

This is a real bug fix independent of the rest of this design: today, every
real credit-card payment or credit is silently skipped. Fixing it also makes
detection (below) reachable, since a `DEPOSIT` never actually lands on a
card account to detect.

### 2. Detection

In `syncCashAccount`, when an imported transaction lands as `CREDIT` on a
`CREDIT_CARD`-mapped account, check its payee/comment against the
configured keyword list (case-insensitive substring match). A match becomes
a staged candidate. Non-matching `CREDIT` transactions (e.g. a merchant
refund) and all `WITHDRAWAL` (purchase) transactions are untouched.

### 3. Configurable keyword list

The keyword list is user-editable, not hardcoded — added as
`paymentKeywords: string[]` on `SyncConfig`
(`src/lib/storage/config.ts`), defaulting to `['PAYMENT', 'AUTOPAY', 'THANK YOU']`.
It follows the exact pattern already established for `lookbackDays`:
spread over `emptyConfig()`'s defaults on read (so configs written before
this field existed still load), and edited in the existing Settings tab
(`SettingsPanel.tsx`) via a draft-input-plus-Save control, persisted through
`writeConfig()`.

### 4. Staging store

A new `storage` entry (alongside the existing `config` / `watermark` /
`history` keys, a single `storageKey('staging')` value) holding the full
list of staged candidates across every card account — same one-value-is-the-
whole-list shape as `history.ts`, so the Staged Transactions UI (below) can
read it in one call rather than per-account:

```ts
interface StagedCandidate {
  sfTransactionId: string;    // identity: the SimpleFIN transaction id of the card-side CREDIT
  cardAccountId: string;      // Wealthfolio account id
  cardActivityId: string | null; // real id — null until a reconciliation pass resolves it via search()
  amount: string;
  postedDate: string;         // ISO date, the card CREDIT's date
  comment: string;
  status: 'pending' | 'ambiguous';
  candidateWithdrawalIds: string[]; // populated once status is 'ambiguous'
}
```

`cardActivityId` starts `null`: detection happens inline during `syncCashAccount`,
before the import has necessarily even settled into a searchable state, and
`import()`'s response can't be trusted for the real id (see above). The
reconciliation pass resolves it via `search()` on its first attempt (matching
by `accountId`/`amount`/`postedDate`/`comment`) and caches it on the record so
later passes don't re-search for it.

This persists across sync runs: the matching withdrawal can already be
imported *before* the card payment is even detected, since the cash debit
typically lands up to 3 days before the card's payment posts.

### 5. Matching / reconciliation pass, every sync run

For each staged candidate, search already-imported `WITHDRAWAL` activities
across *all* mapped cash accounts — not just the current run's freshly
synced rows — via:

```ts
api.activities.search(0, pageSize, { accountIds: cashAccountIds, activityTypes: 'WITHDRAWAL' }, '')
```

(page `0`; `searchKeyword` left empty since it doesn't match `comment`).
Paginate through `meta.totalRowCount` if it exceeds one page. Then, entirely
client-side: filter to rows posted in the 3 days before the card's payment
date, and exact amount match.

- **0 matches** → stays `pending`, retried next run.
- **1 match** → auto-resolve (see below). Drop from staging.
- **2+ matches** → marked `ambiguous`, all candidate ids kept for manual
  resolution — never auto-pick a "closest" match with real money.

Amount comparison reuses `normalise()` from `src/lib/sync/balance.ts` (exported
for this purpose) rather than raw string equality or float parsing: the
probe's live data showed Wealthfolio normalizes persisted amounts (`"40"`,
`"1060.5"`) rather than preserving the two-decimal form SimpleFIN sends
(`"40.00"`), so a raw string comparison between a freshly-detected candidate
and a `search()` result would false-negative on exactly-matching amounts.
`normalise()` already solves this without going through float, consistent
with this codebase's existing money-handling convention. This needs
`manifest.json`'s `activities` permission to declare `search`, `update`, and
`saveMany` (not `getAll`, which nothing in this design calls — see §6 for
why `saveMany` is required alongside `update`).

### 6. Reclassification

Both legs are reclassified in a single `activities.saveMany({ updates: [cardUpdate, withdrawalUpdate] })`
call — cash leg → `TRANSFER_OUT`, card leg → `TRANSFER_IN` — rather than two
sequential `activities.update()` calls. (Amended during implementation: a
task review found the two-call form can leave a pair half-reclassified and
permanently stuck if the second call fails, since resolving the card leg
again only searches `activityTypes: 'CREDIT'` and it would already be
`TRANSFER_IN`. `saveMany` gives one round trip and one exception path
instead.) Each `ActivityUpdate` in the batch echoes back the full existing
row (`id`, `accountId`, `activityType`, `activityDate`, `amount`, `currency`,
`comment`) rather than a partial patch — `ActivityUpdate`'s only *required*
fields are `id`/`accountId`/`activityType`/`activityDate`, and other omitted
fields risk being nulled by the host. No `sourceGroupId` is set (confirmed
not persisted); the two legs are linked only by the staging record's own
bookkeeping until it's dropped.

### 7. Staged Transactions UI

A new tab on the Sync page (alongside Accounts/Summary/Runs/Settings)
listing every unresolved candidate (`pending` and `ambiguous`), so the user
has visibility into everything being tracked, not just cases needing a
decision. Ambiguous entries let the user pick the correct withdrawal (from
`candidateWithdrawalIds`, resolved to human-readable rows via `search()`) or
dismiss the candidate outright.

### 8. Expiry

7 days after the card payment's posted date, any unresolved candidate
(`pending` or `ambiguous`, whether or not the user opened the tab) drops out
of staging and is left as-is (`CREDIT`/`WITHDRAWAL`, unreclassified) — no
transfer is created. Prevents the staged list from growing unbounded when a
pair genuinely doesn't exist (e.g. paid from an untracked account).

### 9. Failure isolation

The reconciliation pass wraps each candidate independently (try/catch per
candidate, log and continue) so one bad match or API error doesn't block
others — consistent with the existing per-institution isolation invariant
in `runSync`.

## Implementation checklist

- [ ] Fix `toActivityImport()` to emit `CREDIT` instead of `DEPOSIT` for
      `CREDIT_CARD` destination accounts
- [ ] `paymentKeywords` config field + Settings tab UI
- [ ] Detection: keyword match on card-side `CREDIT` transactions
- [ ] Staging store (storage key, read/write, matches watermark/history
      pattern)
- [ ] Matching/reconciliation pass wired into `runSync` (0-indexed
      pagination, client-side date/amount filtering)
- [ ] `activities.saveMany()` reclassification for unique matches (full row
      echo per leg, no `sourceGroupId`)
- [ ] Expiry sweep (7 days from card payment date)
- [ ] Staged Transactions UI (list + manual resolve/dismiss for ambiguous
      and pending)
