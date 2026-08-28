# simplefin-wealthfolio-addon

[![Latest release](https://img.shields.io/github/v/release/christancho/simplefin-wealthfolio-addon)](https://github.com/christancho/simplefin-wealthfolio-addon/releases/latest)
[![License: MIT](https://img.shields.io/github/license/christancho/simplefin-wealthfolio-addon)](LICENSE)

Sync bank, credit-card and investment data from [SimpleFIN
Bridge](https://bridge.simplefin.org) into [Wealthfolio](https://wealthfolio.app)
— as a Wealthfolio **addon**, with no separate service to deploy.

---

## What it does

You open Wealthfolio, click **Sync now**, and your SimpleFIN-connected accounts
push their latest transactions and holdings into Wealthfolio.

- **Cash accounts** → transactions imported as activities
- **Investment accounts** → holdings imported as snapshots
- **Account mapping UI** — pair each SimpleFIN account with a Wealthfolio one
- **Per-institution failure isolation** — one broken bank connection never
  blocks the others
- **Sync history and balance-mismatch checks**, rendered in-addon

Everything runs inside Wealthfolio. Credentials live in the system keyring via
the addon `secrets` API; the SimpleFIN Bridge is reached through Wealthfolio's
brokered network layer, so the access credentials are never embedded in a
request the addon itself composes.

## Manual sync only — and why

This addon **cannot** sync automatically on a schedule. That is a hard
constraint of the Wealthfolio addon runtime, not a design choice: addon code
only executes while a Wealthfolio window is open with the addon mounted, and
the SDK exposes no cron or background-job hook. "Sync every night
automatically" is not implementable as an addon in any language.

If you need unattended nightly sync, use the sibling project instead.

### Relationship to `wf-simplefin`

[`wf-simplefin`](https://github.com/christancho/wf-simplefin) solves the same
problem as a standalone always-on Python service. The two are **independent
products** — neither replaces the other:

| | `wf-simplefin` | this project |
|---|---|---|
| Runs as | its own container/service | inside Wealthfolio |
| Sync | automated, nightly, unattended | manual, user-triggered |
| Deployment | a separate container to maintain | install the addon |
| Integration | Wealthfolio REST API | addon `HostAPI` |

Pick `wf-simplefin` if you want it to run without you. Pick this if you'd
rather not run another service.

---

## Requirements

- **Wealthfolio 3.6.2+** (desktop or self-hosted) — the addon declares
  `minWealthfolioVersion: 3.6.2`
- A **SimpleFIN Bridge** account and a setup token

## Installing

1. **[Download the latest addon zip](https://github.com/christancho/simplefin-wealthfolio-addon/releases/latest/download/simplefin-wealthfolio-addon.zip)**
   (always points to the newest release — see the
   [Releases page](https://github.com/christancho/simplefin-wealthfolio-addon/releases/latest)
   for changelogs and older versions).
2. In Wealthfolio, go to **Settings → Addons → Install from file** and pick
   the downloaded zip.
3. Open the new **SimpleFIN Sync** page from the sidebar, paste your SimpleFIN
   Bridge setup token, and map your accounts.

## Development

Requires **Node.js 18+** and **pnpm**.

```bash
pnpm install
pnpm test          # Vitest unit tests
pnpm type-check    # tsc --noEmit
pnpm build         # -> dist/addon.js
pnpm dev:server    # hot-reload dev server for a live Wealthfolio instance
pnpm bundle        # clean + build + zip for distribution
```

To test against a real instance, run `pnpm dev:server` and load the addon into
a self-hosted Wealthfolio via its addon developer settings.

### Architecture notes

Worth knowing before changing anything:

- **Never call `createRoot`.** The host owns a single React root per addon and
  mounts the route `component` itself. Calling `createRoot` leaves orphaned
  trees whose re-renders never reach the DOM — the 3.6 "buttons do nothing"
  bug. Register routes with `component:`, not `render:`.
  *(The published `@wealthfolio/addon-sdk` README still shows the old
  `createRoot` pattern. It is stale — follow the SDK's own type definitions.)*
- **No react-router hooks.** The sandbox has no router provider; the host
  passes the current location to the route component as a `location` prop.
- **Host dependencies are never bundled.** React, react-dom, react-query,
  `@wealthfolio/ui`, date-fns, lucide-react and recharts are provided by the
  host, externalized in `vite.config.ts` and declared in `manifest.json`.
- **Cash sync is stateful, and has to be.** `ActivityImport` carries no
  `sourceSystem`/`sourceRecordId`, so Wealthfolio cannot dedupe our pushes.
  The addon owns idempotency via a per-account watermark plus a bounded
  recent-id window in `storage`. Holdings need none of this —
  `snapshots.checkImport()` returns `existingDates`.
- **`storage` has limits:** keys ≤128 chars from `[A-Za-z0-9_.:-]`, values
  ~250 KB. Use many small keys. `localStorage` is unavailable in the sandbox.

---

## Troubleshooting

**Claiming a setup token fails with a broker rejection.** A setup token is
base64 of a claim URL, and the addon POSTs to whatever host that URL names.
The network broker refuses any host not listed in `manifest.json` →
`network.allowedHosts`, which declares `bridge.simplefin.org` and
`beta-bridge.simplefin.org`. A token issued by a Bridge on some other host —
a self-hosted or white-label deployment — is rejected by the broker before
any request goes out. That is a manifest allowlist problem, not a code
problem: add the host to `allowedHosts` and rebuild.

**A setup token is refused with HTTP 403.** Setup tokens are single-use. If a
claim was already made with that token (including a partially-failed
attempt), generate a fresh one in the SimpleFIN Bridge dashboard.

---

## Contributing

Work is tracked in GitHub Issues and the project board. In short: branch from
`dev` as `feature/{issue}-{slug}`, PR into `dev`, and include `Closes #N`.

## License

[MIT](LICENSE)
