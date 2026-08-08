# Changelog

All notable changes to the SimpleFIN Sync addon are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Addon skeleton: Vite library build to `dist/addon.js`, TypeScript, Vitest
  harness, and a `manifest.json` declaring the `network`, `secrets`,
  `accounts`, `activities` and `snapshots` permissions plus the SimpleFIN
  Bridge network allowlist.
- Implementation plan and design spec for v1 under `docs/superpowers/`.
- GitHub Actions enforcing agreement between project board status and issue
  open/closed state, replacing the built-in project workflows (which cannot be
  enabled through the API).

### Changed

- Resolved the design's open question on idempotency. `ActivityImport` exposes
  no `sourceSystem`/`sourceRecordId`, so cash-transaction deduplication is
  owned by the addon via a per-account watermark and a bounded recent-id
  window rather than delegated to Wealthfolio.

### Removed

- `setup.sh`, the one-time repository bootstrap script, now that the repo is
  configured.
