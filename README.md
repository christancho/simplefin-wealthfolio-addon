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

See [DEVELOPMENT.md](DEVELOPMENT.md) for setup, commands, and architecture notes.

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

---

## Relationship to `wf-simplefin`

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
