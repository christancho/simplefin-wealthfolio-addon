# repo-template

A project template that comes pre-wired with:

- A **three-branch pipeline**: `main` (production) → `stg` (staging) → `dev` (integration)
- **GitHub Actions** that automatically move issues across the project board as code progresses
- A **GitHub Project board** with Status, Priority, Size, and Estimate fields
- **Branch protection** so nobody (including you) can accidentally push directly to `main`, `stg`, or `dev`
- A **setup script** that configures everything in one shot

---

## What you'll need before starting

1. **GitHub CLI (`gh`)** installed on your machine.
   Check with: `gh --version`
   Install from: https://cli.github.com

2. **A Personal Access Token (PAT)** from GitHub with two scopes: `repo` and `project`.

   How to create one:
   - Go to https://github.com/settings/tokens
   - Click **Generate new token (classic)**
   - Give it a name like `automation`
   - Check `repo` (full repo access) and `project` (project board access)
   - Click **Generate token** and copy it — you won't see it again

3. **`jq`** installed (a command-line JSON tool).
   Check with: `jq --version`
   Install with: `brew install jq`

---

## Creating a new project from this template

Clone this template repo, then run the setup script from inside it:

```bash
git clone https://github.com/christancho/repo-template
cd repo-template
bash setup.sh
```

Or run it directly without cloning:

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/christancho/repo-template/main/setup.sh)
```

> **Note:** The script auto-detects the template repo from its own git remote. If you run it via `curl` (no local clone), it will prompt you for the template repo path instead.

The script will prompt you for:

- **GitHub Personal Access Token** — entered hidden (no echo)
- **GitHub username or org** — the account that will own the new repo
- **New repo name** — e.g. `my-new-project`
- **Project board title** — defaults to the repo name
- **Visibility** — `private` or `public` (defaults to `private`)

Then it will automatically:

1. Create the repo on GitHub from this template and clone it locally
2. Create the `dev` and `stg` branches and push them
3. Create the GitHub Project board with all columns and fields
4. Commit `.github/project-config.json` (stores the board's internal IDs)
5. Set `PROJECT_NUMBER` as a GitHub Actions variable
6. Apply branch protection rules to `main`, `stg`, and `dev`
7. Offer to set the `GH_PAT` secret (required for workflow automation)

After setup, `cd` into the new project folder and start working.

---

## How it works day to day

### Branches

There are three permanent branches:

| Branch | Purpose |
|---|---|
| `main` | Production — what's live |
| `stg` | Staging — tested, waiting to go live |
| `dev` | Integration — where finished features land |

You never commit directly to any of these. All work happens on feature branches.

### Starting work on an issue

1. Create a GitHub issue for the work you're about to do
2. Note the issue number (e.g. `#42`)
3. Create a branch named after it:

```bash
git checkout dev
git pull
git checkout -b feature/42-short-description
```

As soon as you push this branch, GitHub Actions automatically moves issue #42 to **In Progress** on the board.

### When you're done with the work

Push your branch and open a pull request targeting `dev`:

```bash
git push -u origin feature/42-add-login-page
gh pr create --base dev --title "feat: add login page" --body "Closes #42"
```

The `Closes #42` in the PR body is important — it's what tells GitHub Actions which issue to move. When you open the PR, issue #42 moves to **In Review**. When the PR is merged, it moves to **Done**.

### Deploying to staging

After merging a PR to `dev`, GitHub Actions automatically creates a `dev → stg` PR for you. Merge it when you're ready to test on staging.

### Deploying to production

After merging to `stg`, GitHub Actions automatically creates a `stg → main` PR. Merge it when you're ready to go live.

---

## Project board columns

| Column | When an issue moves here |
|---|---|
| Backlog | Issue created (automatic) |
| Ready | PM reviews backlog and marks it ready (manual) |
| In Progress | Feature branch `feature/123-*` pushed (automatic) |
| In Review | PR opened targeting `dev` (automatic) |
| Done | PR merged to `dev` (automatic) |

Use a **Blocked** label on any issue that's stuck — it can sit in any column with that label rather than needing a separate column.

## GitHub Actions workflows

Five workflows run automatically — you never need to trigger them manually:

| Workflow | What triggers it | What it does |
|---|---|---|
| `issue-to-backlog.yml` | New issue opened | Adds the issue to the project board as Backlog |
| `issue-to-in-progress.yml` | `feature/*` branch pushed | Moves the linked issue to In Progress |
| `issue-to-in-review.yml` | PR opened targeting `dev` | Moves issues from `Closes #N` lines to In Review |
| `pr-to-stg.yml` | PR merged into `dev` | Moves issues to Done, creates `dev → stg` PR |
| `pr-to-main.yml` | PR merged into `stg` | Creates `stg → main` PR |

The key to making the automation work is always including `Closes #N` in your PR body for every issue the PR resolves.

---

## Recommended Claude Code plugins

Two plugins that work well with this template's workflow:

### superpowers

Adds a skills system to Claude Code — structured workflows for planning, debugging, code review, and more.

```
/plugin install superpowers
/reload-plugins
```

### chat-autoexporter

Automatically exports your Claude Code sessions to `.claude/chat-exports/` whenever context compaction fires or a session ends. Useful for keeping a searchable history of decisions and reasoning.

```
/plugin marketplace add christancho/chat-autoexporter
/plugin install chat-autoexporter@christancho
/reload-plugins
```

No npm dependencies — pure Node.js standard library. If you want to inspect the code before running it, clone the repo and follow the manual setup in its README.

---

## Files in this template

```
setup.sh                          — Run once to create and configure a new repo
README.md                         — This file
docs/git-strategy.md              — Full reference for the branching strategy
.github/
  project-config.json             — Board IDs written by setup.sh (don't edit)
  scripts/
    move-issue.sh                 — Moves a single issue to a given status
  workflows/
    issue-to-backlog.yml          — Issue opened → added to board as Backlog
    issue-to-in-progress.yml      — feature/* branch pushed → issue moves to In Progress
    issue-to-in-review.yml        — PR opened → dev → issues move to In Review
    pr-to-stg.yml                 — PR merged → dev → issues Done + creates dev→stg PR
    pr-to-main.yml                — PR merged → stg → creates stg→main PR
```
