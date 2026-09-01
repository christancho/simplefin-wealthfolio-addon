# Agent Instructions

Read this entire file before starting any task.

---

## What this project does

`simplefin-wealthfolio-addon` syncs bank, credit-card, and investment data from
[SimpleFIN Bridge](https://bridge.simplefin.org) into
[Wealthfolio](https://wealthfolio.app) as a **Wealthfolio addon** — a
TypeScript/React module built against `@wealthfolio/addon-sdk` that runs inside
Wealthfolio itself, with no separate service to deploy.

- **Input:** accounts, transactions, and holdings pulled from the user's
  SimpleFIN access URL via a *brokered* `network.request()` (the Bridge host is
  declared in `manifest.json` → `network.allowedHosts`; auth is resolved from
  the addon `secrets` store by key, never embedded in the request).
- **Output:** cash transactions pushed via `activities.checkImport()` →
  `.import()`; holdings pushed via `snapshots.checkImport()` →
  `.importSnapshots()`. Account mapping uses `accounts.getAll()`/`.create()`.
- **State:** the SimpleFIN access URL lives in `secrets` (system keyring);
  sync history and diagnostics live in the addon's `storage` key-value store.
- **Trigger model:** **manual "Sync now" only.** This is a hard constraint of
  the addon runtime, not a preference — addon code only executes while a
  Wealthfolio window/tab is open with the addon mounted. There is no
  cron/background-job hook in the SDK, so unattended nightly sync is
  impossible in an addon regardless of implementation.

### Relationship to `wf-simplefin`

[`wf-simplefin`](https://github.com/christancho/wf-simplefin) is the sibling
project: the same idea as a standalone always-on Python service with a
background scheduler and admin web UI. The two are **independent products**,
not a migration:

| | `wf-simplefin` | this project |
|---|---|---|
| Runs as | its own container/service | inside Wealthfolio |
| Sync | automated, nightly, unattended | manual, user-triggered |
| Deployment | separate container to maintain | install the addon |

Do not treat one as deprecating the other, and do not port `wf-simplefin`
architecture wholesale — the `HostAPI` surface, not a REST client, is the
integration boundary here.

### Invariants carried over from `wf-simplefin`

- **Per-institution failure isolation** — one broken Bridge connection surfaces
  an error for that institution only; every other mapped account still syncs.
- **Statelessness (pending verification)** — `wf-simplefin` keeps no local
  ledger of what it has pushed, relying on Wealthfolio's
  `sourceSystem`/`sourceRecordId` dedupe. Whether `activities.import()` /
  `checkImport()` expose those same fields through the addon API is **not yet
  confirmed** and must be verified against the `ActivityImport` /
  `ImportActivitiesResult` types (ideally with a live test) early in
  implementation. It decides whether this addon can stay stateless or must
  track pushed records itself in `storage`.

Full design: `docs/superpowers/specs/2026-08-07-simplefin-addon-design.md`.

---

## Tech stack

- TypeScript + React, built with Vite (matches the addon-sdk stack)
- `@wealthfolio/addon-sdk` — `AddonContext` / `HostAPI` is the only integration
  surface; never reach for Wealthfolio's REST API from addon code
- Vitest for unit tests — mock `AddonContext`/`HostAPI` rather than hitting a
  live instance
- Manual/integration testing via the addon-sdk dev server (`pnpm dev:server`,
  live reload) against a real self-hosted Wealthfolio instance

---

## Behavioral Guidelines

> Inspired by [andrej-karpathy-skills](https://github.com/multica-ai/andrej-karpathy-skills)

### 1. Think before coding

Before implementing anything:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them — don't pick one silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

### 2. Simplicity first

Write the minimum code that solves the problem. Nothing speculative.
- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

### 3. Surgical changes

Touch only what you must. Clean up only your own mess.
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it — don't delete it.
- Remove imports/variables/functions that **your** changes made unused. Don't remove pre-existing dead code unless asked.

Every changed line should trace directly to the user's request.

### 4. Goal-driven execution

Transform tasks into verifiable goals before starting:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan upfront:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

---

## Coding preferences

- **No hardcoded numeric values** — only text labels may be hardcoded. All scores, thresholds, and numeric outputs must be computed from real data. If a value can't be computed yet, return `null` rather than a magic number.

---

## Task Management

All tasks and features are tracked in **GitHub Projects**:
- Use `gh issue create` to create new issues
- Use `gh project item-add` to add issues to the board
- Do NOT use TodoWrite, task files, or in-session task lists as a substitute — GitHub Issues is the source of truth
- Group related tasks under a single parent issue with a checklist when possible
- The project board's status and the issue's open/closed state must always agree. On this board the built-in **Auto-close issue** and **Item closed** project workflows are disabled and **cannot be enabled through the API** (GraphQL exposes only `deleteProjectV2Workflow`; the `projects_v2_item` webhook is org-scoped and this project is user-owned). The invariant is therefore enforced by GitHub Actions instead:
  - **Issue closed → status Done** — `.github/workflows/issue-closed-to-done.yml`
  - **Status Done → issue closed** — `.github/workflows/pr-to-stg.yml`, the only automated path that sets Done
- Manually dragging a card to Done in the project UI will **not** close the issue. Close the issue instead and let the Action move the card. Do not hand-set an item to Done and assume the issue closed — verify it.

---

## Git workflow

- All feature work branches from `dev` using the naming convention `feature/{issue-number}-{short-description}`
- Feature branches always PR into `dev`, never into `stg` or `main`
- Every PR body must include `Closes #N` for each issue the PR resolves — this drives the project board automation
- Before starting work on an existing branch, always run `git merge dev` first to pick up anything merged since the branch was cut

---

## Self-Correcting Rules Engine

This file contains a growing ruleset that improves over time. **At session start, read the entire "Learned Rules" section before doing anything.**

### How it works

1. When the user corrects you or you make a mistake, **immediately append a new rule** to the "Learned Rules" section at the bottom of this file.
2. Rules are numbered sequentially and written as clear, imperative instructions.
3. Format: `N. [CATEGORY] Never/Always do X — because Y.`
4. Categories: `[STYLE]`, `[CODE]`, `[ARCH]`, `[TOOL]`, `[PROCESS]`, `[DATA]`, `[UX]`, `[OTHER]`
5. Before starting any task, scan all rules below for relevant constraints.
6. If two rules conflict, the higher-numbered (newer) rule wins.
7. Never delete rules. If a rule becomes obsolete, append a new rule that supersedes it.

### When to add a rule

- User explicitly corrects your output ("no, do it this way")
- User rejects a file, approach, or pattern
- You hit a bug caused by a wrong assumption about this codebase
- User states a preference ("always use X", "never do Y")

### Rule format example

```
14. [CODE] Always use `bun` instead of `npm` — user preference, bun is installed globally.
15. [STYLE] Never add emojis to commit messages — project convention.
16. [ARCH] API routes live in `src/server/routes/`, not `src/api/` — existing codebase pattern.
```

---

## Learned Rules

<!-- New rules are appended below this line. Do not edit above this section. -->

1. [PROCESS] Never commit non-trivial logic (algorithms, calculations, data transformations) without first verifying it against real output — passing tests are not sufficient if the logic was never actually run.
2. [CODE] Never write empty or silent error handlers — every caught error must either re-throw, be logged with explicit source attribution, or be stored somewhere visible. If an error is genuinely safe to ignore, add a comment explaining the invariant that guarantees it.
3. [CODE] Never suppress compiler or runtime warnings — always fix the root cause. Warnings exist for a reason; silencing them hides real problems.
4. [CODE] Never fire-and-forget operations that can fail — background tasks must persist their result (success or error) somewhere the user can see it. Logging to console alone is not enough for user-facing operations.
5. [UX] Always order the rows of a financial summary so reading order matches the arithmetic — opening entry, then movements, then the resulting total, then whatever it reconciles against. Leading with the answer forces the reader to work backwards and makes the figures look like they don't add up.
6. [PROCESS] Always choose Subagent-Driven execution (never Inline Execution) when the writing-plans skill's handoff offers a choice — user default preference, stated explicitly. Proceed with it directly without asking again.
7. [PROCESS] Never rely on GitHub's native `Closes #N` behaviour to close an issue in this repo — feature branches PR into `dev`, but the repo's default branch is `main`, and GitHub only honours the closing keyword on merges into the default branch, so it silently never fires. Keep the `Closes #N` lines (workflows grep them for issue numbers), but always verify the issue actually closed rather than assuming the merge handled it.
8. [TOOL] Never assume a GitHub Projects built-in workflow can be enabled programmatically — the GraphQL schema has no create/update mutation for `ProjectV2Workflow`, only `deleteProjectV2Workflow`, and `projects_v2_item` webhooks are organization-scoped so they never fire for this user-owned project. Supersedes the closing mechanism described in rule 7: closure is done by `pr-to-stg.yml` (Done → close) and `issue-closed-to-done.yml` (close → Done), both plain Actions. Query `user(login:...){projectV2(number:N){workflows{nodes{name enabled}}}}` to check the real enabled/disabled state before diagnosing board automation.
9. [TOOL] Never trust the `@wealthfolio/addon-sdk` published README over its shipped type definitions — the README's example still calls `createRoot`, which the 3.6 types explicitly forbid (it causes the "buttons do nothing" bug). Read `node_modules/@wealthfolio/addon-sdk/dist/src/*.d.ts` as the source of truth, and validate enum-like values (e.g. sidebar `icon` against `ADDON_ICON_NAMES`) rather than guessing plausible names.
10. [CODE] Never send an activity `date` to the host as a bare `YYYY-MM-DD` — always a full RFC3339 instant (`isoInstant()` in `src/lib/sync/activities.ts`). Wealthfolio's deserializer expands a date-only value to *midnight UTC* (`activities_model.rs`, `timestamp_format::deserialize`) and its frontend renders that in the viewer's zone, so every row showed 8:00 PM the previous day in America/Toronto. The SimpleFIN Bridge encodes its own date-only values at noon UTC (verified against the raw feed in the sibling `wf-simplefin` project, issue #6), so passing the instant through keeps the calendar date correct in every zone. Snapshot dates are exempt — those are genuine date buckets matched against `checkImport`'s `existingDates`.
11. [CODE] Never discard a signal the host already hands back — audit every field of a `check*`/`import*` result before ignoring it. Three bugs shared this shape: `snapshots.checkImport` returns `symbols[].found` (an unresolved symbol imports anyway and gets priced against the wrong security), `activities.import` returns `summary.success`/`imported` (a short batch was advancing the watermark past rows that never landed), and a null Wealthfolio balance was reported the same way as an agreeing one. If a returned field is genuinely not actionable, say why in a comment rather than leaving it unread.
12. [TOOL] Never leave the test timezone to the machine — `vitest.config.ts` pins `TZ: 'America/Toronto'`. The suite ran green in UTC CI while the one-day activity-date shift was live in production; date handling is only exercised against a UTC-negative zone if the zone is pinned.
