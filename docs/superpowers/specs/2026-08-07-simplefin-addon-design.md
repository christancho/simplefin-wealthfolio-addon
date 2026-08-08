# SimpleFIN Wealthfolio Addon — Design

## Context

[wf-simplefin](https://github.com/christancho/wf-simplefin) syncs SimpleFIN
Bridge transactions/holdings into self-hosted Wealthfolio via a standalone
Python service (an always-on admin server + background scheduler). This
project explores the same idea via Wealthfolio's [addon
system](https://wealthfolio.app/docs/addons/getting-started/) instead: a
TypeScript/React module that runs inside Wealthfolio itself.

The two are **independent products**, not a replacement of one by the other:

- **wf-simplefin**: automated, unattended, nightly sync; runs as its own
  service; requires deploying and maintaining a separate container.
- **simplefin-wealthfolio-addon** (this project): manual-trigger sync, no
  separate service — installs into Wealthfolio and runs entirely inside it.

This split exists because of a hard constraint in the addon runtime, not a
preference: **addons cannot run unattended background jobs.** Addon code
(confirmed against `@wealthfolio/addon-sdk` and the `wealthfolio/wealthfolio`
repo's `packages/addon-sdk`) only executes while a Wealthfolio window/tab is
open with the addon mounted — there is no cron/background-job hook in the
SDK. So a "sync every night automatically" addon isn't possible regardless of
implementation language; the only viable addon-native model is "open
Wealthfolio, click sync."

## Why this is viable as a standalone addon (no backend service)

Wealthfolio's addon `HostAPI` (`packages/addon-sdk/src/host-api.ts`) is rich
enough to do the whole job client-side, with no external service:

- `activities.checkImport()` / `.import()` — push cash transactions
- `snapshots.checkImport()` / `.importSnapshots()` — push holdings snapshots
  (HOLDINGS-tracking-mode accounts)
- `accounts.getAll()` / `.create()` — read/create Wealthfolio accounts
- `secrets.set/get/delete()` — system-keyring-backed, addon-scoped secure
  storage (used for the SimpleFIN access URL)
- `storage` — durable per-addon key-value storage (used for sync
  history/diagnostics, replacing wf-simplefin's `ADMIN_STATE_DIR`)
- `network.request()` — a *brokered* HTTPS request to a host declared in the
  addon's `manifest.json` (`network.allowedHosts`), with `basic`/`bearer`
  auth resolved from the `secrets` store by key rather than embedded in the
  request — used to call the SimpleFIN Bridge API directly

Addons run in a sandboxed iframe (self-hosted/web) or within the Tauri
desktop app; either way this same `HostAPI` is available, so the addon works
for self-hosted Wealthfolio (Docker, `apps/server`) as well as desktop.

## V1 scope: full parity with wf-simplefin

- Claim SimpleFIN setup token; store the resulting access URL via
  `secrets.set()`
- Account mapping UI: list SimpleFIN accounts (via brokered `network`
  request to the Bridge) alongside Wealthfolio accounts
  (`accounts.getAll()`/`.create()`); map, create-on-the-spot, or skip
- Manual "Sync now" trigger — no scheduler
- Cash transactions → `activities.checkImport()` then `.import()`
- Investment/holdings accounts → `snapshots.checkImport()` then
  `.importSnapshots()`
- Sync history (last N runs) persisted via `storage`, rendered in-addon
- Bridge error visibility: per-institution error banner with a link to the
  Bridge dashboard
- Balance-mismatch check: compare SimpleFIN's reported balance to
  Wealthfolio's for each mapped account after sync

## Data flow

1. User opens the addon in Wealthfolio, clicks "Sync now"
2. Addon sends a brokered request to the SimpleFIN Bridge for
   accounts/transactions/holdings
3. Per mapped account: transform Bridge data into
   `ActivityImport`/`SnapshotInput` shapes
4. Per mapped account: `checkImport()` (validate) then
   `import()`/`importSnapshots()` (push) — **failures are isolated per
   account/institution**, matching wf-simplefin's invariant that one broken
   institution never blocks the others
5. Write a run summary (per-account results, errors, balance mismatches) to
   `storage`
6. Re-render history/diagnostics from the updated `storage` state

## Resolved: idempotency

**Verified against `@wealthfolio/addon-sdk@3.6.2` type definitions
(2026-08-07). The answer is no — this addon cannot be stateless.**

wf-simplefin is stateless: it relies on Wealthfolio's own
`sourceSystem`/`sourceRecordId` dedupe (the same mechanism its Connect broker
sync uses), so re-pushing the same transaction is a no-op with no local ledger
to maintain. The addon API does **not** expose those fields:

- `ActivityImport` (`data-types.d.ts:270-308`) — the only input shape accepted
  by `activities.import()` and `.checkImport()` — has no `sourceSystem`, no
  `sourceRecordId`, and no `idempotencyKey`.
- Those three fields exist only on `Activity` (`:138-141`) and
  `ActivityDetails` (`:181-183`), both read/stored models, and on
  `ImportRun.sourceSystem` (`:808`).
- `HostAPI` (`host-api.d.ts:665-708`) exposes no import-run or broker-sync
  surface that would let an addon set them another way.

What the SDK does offer is host-side duplicate detection: `checkImport()`
returns rows annotated with `duplicateOfId` / `duplicateOfLineNumber`,
`import()` accepts `forceImport`, and `ImportActivitiesSummary` reports a
`duplicates` count. The matching heuristic is host-internal and unverified, so
it is treated as a safety net, not as the primary mechanism.

### Decision: per-account watermark + recent-id window

Cash-transaction idempotency is owned by the addon, stored in `storage`:

- **Watermark** — per mapped account, the last successfully synced posted
  date. Subsequent syncs only request/push transactions at or after it.
- **Recent-id window** — a small rolling set of recently-seen SimpleFIN
  transaction ids, so transactions that post late (dated before the
  watermark but appearing after it was written) are still recognised as
  already-pushed rather than re-sent or silently skipped.
- `checkImport()`'s duplicate flags remain a secondary guard; a row the host
  marks duplicate is not force-imported.
- A **reset/backfill** path must exist for when the watermark drifts or an
  account is re-mapped.

This is bounded by construction, which matters because of a `StorageAPI`
constraint the original design did not account for.

### `StorageAPI` limits (verified)

Keys are ≤128 characters from `[A-Za-z0-9_.:-]`; values are capped at roughly
250 KB each, and the SDK docs explicitly direct addons to "use many small keys
rather than one large blob." A full ledger of every synced transaction id would
outgrow this on a multi-year, multi-account history — the watermark design
stays comfortably inside it. `localStorage` is unavailable in the sandboxed
opaque-origin iframe, so `storage` is the only durable option.

### Holdings are unaffected

Snapshots need no local state: `snapshots.checkImport()` returns
`CheckSnapshotImportResult.existingDates`, giving a host-side idempotency check
for free. The statefulness above is confined to cash transactions.

## Error handling & testing

- Per-institution failure isolation (one broken Bridge connection surfaces an
  error for that institution only; other accounts still sync)
- Unit tests: mock `AddonContext`/`HostAPI`, Vitest (matches the SDK's
  React/TS/Vite stack)
- Manual/integration testing: the addon-sdk dev server (`pnpm dev:server`,
  live reload) against a real self-hosted Wealthfolio instance
