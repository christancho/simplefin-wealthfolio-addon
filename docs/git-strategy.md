# Git Strategy

Three-environment trunk-based flow with automated GitHub Projects lifecycle. Each unit of work is a feature branch → PR → `dev` → staging → production.

---

## Branch Model

```
main   ← production (protected)
stg    ← staging  (protected)
dev    ← integration (protected)
  └── feature/123-slug  ← all feature work
```

**Rules:**
- All feature work branches from `dev`, targets `dev`
- Never branch from `stg` or `main`
- Never PR directly into `stg` or `main` — promotion is automated
- Never commit directly to `dev`, `stg`, or `main`

---

## Branch Naming

```
feature/{issue-number}-{slug}
```

Examples:
- `feature/42-add-login`
- `feature/18-user-dashboard`
- `feature/103-fix-signup-error`

The number is the GitHub issue number for the work being done. The slug is a short description — kebab-case, 2–4 words.

---

## Starting a Feature Branch

```bash
git checkout dev
git pull
git checkout -b feature/42-add-login
```

At the start of any resumed work session on an existing branch:

```bash
git merge dev
```

Always merge latest `dev` before doing anything — features merged to `dev` after your branch was cut are otherwise invisible.

---

## Commit Conventions

Conventional commits, no emojis:

```
feat: add user login page
fix: handle empty email on signup
chore: upgrade dependencies
docs: document deployment process
refactor: extract auth logic into separate module
```

---

## Pull Requests

### Target

Always target `dev`. Never `stg` or `main`.

### Body (required)

Every PR must include:

1. **Summary** — bullet list of what changed
2. **Test plan** — what was verified
3. **Closes lines** — one per issue the PR resolves

```markdown
## Summary
- Added user login with email and password
- Redirects to dashboard on success

## Test plan
- [x] Tested valid login flow
- [x] Tested invalid credentials error message

Closes #42
```

The `Closes #N` lines drive GitHub Projects automation — do not omit them.

### Title

Short, imperative, under 70 characters:

```
feat: add user login page
```

---

## Promotion Pipeline (Automated)

Once a feature PR merges to `dev`, GitHub Actions handles the rest:

```
feature branch → dev   (manual PR, human review)
dev → stg              (auto-created PR, merge when ready to test)
stg → main             (auto-created PR, merge when ready to release)
```

The `dev→stg` PR is created automatically on every merge to `dev`. The `stg→main` PR is created automatically on every merge to `stg`. Both are titled `promote: {from} -> {to}` with a commit log in the body.

---

## GitHub Projects Status Flow

| Status | Trigger | How |
|---|---|---|
| **Backlog** | Issue created | Automated — `issue-to-backlog` workflow |
| **Ready** | PM triages and prioritises | Manual — PM moves card |
| **In Progress** | `feature/*` branch pushed | Automated — GitHub Action |
| **In Review** | PR opened with `Closes #N` | Automated — GitHub Action |
| **Done** | PR merged to `dev` | Automated — built-in GitHub Projects |

Two manual moves in the whole flow: PM moves **Backlog → Ready** during grooming; developer moves nothing — branch creation and PR events handle everything else.

Use a **Blocked** label (not a column) when an issue is stuck. An issue can be `In Progress + Blocked` which is more expressive than a separate column that's usually empty.

---

## GitHub Actions Workflows

Five workflows wire up the automation. Each reads `.github/project-config.json` for node IDs and uses `GH_PAT` (a personal access token with `project` scope) as `GH_TOKEN`.

| File | Trigger | Action |
|---|---|---|
| `issue-to-backlog.yml` | Issue opened | Adds issue to board → Backlog |
| `issue-to-in-progress.yml` | `feature/*` branch pushed | Issue → In Progress |
| `issue-to-in-review.yml` | PR opened → `dev` | Issues → In Review |
| `pr-to-stg.yml` | PR merged → `dev` | Issues → Done + create `dev→stg` PR |
| `pr-to-main.yml` | PR merged → `stg` | Create `stg→main` PR |

The helper script `.github/scripts/move-issue.sh <issue_number> "<Status Name>"` handles the GraphQL mutation. Workflows call it in a loop over extracted issue numbers.

---

## Project Config File

`.github/project-config.json` stores the GitHub Projects node IDs so workflows don't hardcode them. Written automatically by `setup.sh` — do not edit manually.

```json
{
  "project_node_id": "PVT_...",
  "status_field_id": "PVTSSF_...",
  "options": {
    "Backlog":      "...",
    "Ready":        "...",
    "In Progress":  "...",
    "In Review":    "...",
    "Done":         "..."
  }
}
```

---

## Branch Protection Rules

Applied automatically by `setup.sh`. To apply manually via the `gh` CLI:

```bash
gh api repos/{owner}/{repo}/branches/{branch}/protection \
  --method PUT \
  --field enforce_admins=true \
  --field allow_force_pushes=false \
  --field allow_deletions=false \
  --field restrictions=null \
  --field required_status_checks=null
```

### Rules applied to all three branches (`main`, `stg`, `dev`)

| Rule | Value | Effect |
|---|---|---|
| `enforce_admins` | `true` | Rules apply to repo admins too — no bypass |
| `allow_force_pushes` | `false` | `git push --force` is rejected |
| `allow_deletions` | `false` | Branch cannot be deleted via push |

### Recommended additions for `main` and `stg` on team projects

| Rule | Recommended value | Why |
|---|---|---|
| `required_pull_request_reviews` | 1 approving review | Prevents direct pushes |
| `dismiss_stale_reviews` | `true` | New commits invalidate existing approval |
| `required_conversation_resolution` | `true` | All review threads must be resolved before merge |

`dev` can be left without required reviews for solo developers — it is never deployed to production directly.

---

## Required Secrets

| Secret | Scope | Used for |
|---|---|---|
| `GH_PAT` | `repo`, `project` | All GitHub Actions — moves issues, creates PRs |

---

## GitHub Project Fields

| Field | Type | Options |
|---|---|---|
| **Status** | Single select | Backlog, Ready, In Progress, In Review, Done |
| **Priority** | Single select | P0 (critical), P1 (high), P2 (normal) |
| **Size** | Single select | XS, S, M, L, XL |
| **Estimate** | Number | Story points or hours |
| **Technical analysis** | Single select | Pending, In progress, Complete |

Plus GitHub's built-in fields: Assignees, Labels, Milestone, Linked pull requests, Reviewers, Parent issue.

---

## Setting Up

See `README.md` — `setup.sh` handles everything in one command.
