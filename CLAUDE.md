# Agent Instructions

Read this entire file before starting any task.

---

## What this project does

<!-- Describe your project here. What problem does it solve? What are the main inputs and outputs? -->

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
