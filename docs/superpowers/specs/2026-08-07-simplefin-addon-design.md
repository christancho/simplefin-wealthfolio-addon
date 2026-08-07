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

## Open question: idempotency

wf-simplefin is stateless — it relies on Wealthfolio's own
`sourceSystem`/`sourceRecordId` dedupe (the same mechanism its Connect broker
sync uses) so re-pushing the same transaction is a no-op, with no local
ledger to maintain. It is not yet confirmed whether `activities.import()` /
`checkImport()` expose the same dedupe fields through the addon API as the
REST API does. This needs to be verified against the `ActivityImport` /
`ImportActivitiesResult` types (and ideally a live test) early in
implementation — it determines whether this addon can stay equally
stateless, or needs to track what it has already pushed itself (e.g. via
`storage`).

## Error handling & testing

- Per-institution failure isolation (one broken Bridge connection surfaces an
  error for that institution only; other accounts still sync)
- Unit tests: mock `AddonContext`/`HostAPI`, Vitest (matches the SDK's
  React/TS/Vite stack)
- Manual/integration testing: the addon-sdk dev server (`pnpm dev:server`,
  live reload) against a real self-hosted Wealthfolio instance
