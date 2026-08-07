#!/usr/bin/env bash
# Creates and fully configures a new GitHub repo from this template.
# Run from anywhere — no prior clone needed.
#
# Usage:
#   bash setup.sh
#
# Requirements: gh CLI, jq

set -euo pipefail

echo "=== New project setup ==="
echo ""

# ── 1. PAT (interactive, hidden) ─────────────────────────────────────────────
if [ -z "${GH_TOKEN:-}" ]; then
  read -rsp "GitHub Personal Access Token (repo + project scopes): " GH_TOKEN
  echo ""
fi
export GH_TOKEN
[ -z "$GH_TOKEN" ] && { echo "Token required"; exit 1; }

# ── 2. Prompt for repo details ────────────────────────────────────────────────
read -rp "GitHub username or org: " OWNER
[ -z "$OWNER" ] && { echo "Owner required"; exit 1; }

read -rp "New repo name: " REPO
[ -z "$REPO" ] && { echo "Repo name required"; exit 1; }

read -rp "Project board title [$REPO]: " PROJECT_TITLE
PROJECT_TITLE="${PROJECT_TITLE:-$REPO}"

read -rp "Visibility [private/public]: " VISIBILITY
VISIBILITY="${VISIBILITY:-private}"
if [[ "$VISIBILITY" != "private" && "$VISIBILITY" != "public" ]]; then
  echo "Invalid visibility: must be 'private' or 'public'"; exit 1
fi

echo ""

# ── 3. Create and clone the repo ──────────────────────────────────────────────
TEMPLATE_REPO="christancho/repo-template"

echo "Creating $OWNER/$REPO from template $TEMPLATE_REPO..."
if ! gh repo create "$OWNER/$REPO" \
  --template "$TEMPLATE_REPO" \
  "--$VISIBILITY" \
  --clone; then
  echo "ERROR: gh repo create failed (exit $?)" >&2
  exit 1
fi

cd "$REPO"
echo "Cloned into $(pwd)"
echo ""

# Embed token in remote URL so git push doesn't prompt for credentials
git remote set-url origin "https://x-access-token:${GH_TOKEN}@github.com/${OWNER}/${REPO}.git"

# ── 4. Create dev and stg branches ───────────────────────────────────────────
for BRANCH in dev stg; do
  if git ls-remote --exit-code --heads origin "$BRANCH" > /dev/null 2>&1; then
    echo "Branch already exists: $BRANCH"
  else
    git checkout -b "$BRANCH" 2>/dev/null || git checkout "$BRANCH"
    git push -u origin "$BRANCH"
    echo "Created branch: $BRANCH"
  fi
done
git checkout main

# ── 5. Create GitHub Project ──────────────────────────────────────────────────
echo ""
echo "Creating GitHub Project..."

OWNER_ID=$(gh api graphql -f query="{user(login:\"$OWNER\"){id}}" --jq '.data.user.id' 2>/dev/null \
  || gh api graphql -f query="{organization(login:\"$OWNER\"){id}}" --jq '.data.organization.id')
[ -z "$OWNER_ID" ] && { echo "Could not resolve owner ID for '$OWNER'"; exit 1; }
echo "Owner: $OWNER ($OWNER_ID)"

RESULT=$(gh api graphql -f query="
mutation {
  createProjectV2(input: { ownerId: \"$OWNER_ID\", title: \"$PROJECT_TITLE\" }) {
    projectV2 { id number }
  }
}")
PROJECT_ID=$(echo "$RESULT" | jq -r '.data.createProjectV2.projectV2.id')
PROJECT_NUMBER=$(echo "$RESULT" | jq -r '.data.createProjectV2.projectV2.number')
echo "Created project #$PROJECT_NUMBER (id: $PROJECT_ID)"

# ── 6. Get Status field ID ────────────────────────────────────────────────────
STATUS_FIELD_ID=$(gh api graphql -f query="
{
  node(id: \"$PROJECT_ID\") {
    ... on ProjectV2 {
      fields(first: 20) {
        nodes {
          ... on ProjectV2SingleSelectField { id name }
        }
      }
    }
  }
}" --jq '.data.node.fields.nodes[] | select(.name == "Status") | .id')

# ── 7. Set Status options ─────────────────────────────────────────────────────
# Note: projectId is NOT part of UpdateProjectV2FieldInput; fieldId alone identifies the field.
gh api graphql -f query="
mutation {
  updateProjectV2Field(input: {
    fieldId: \"$STATUS_FIELD_ID\"
    singleSelectOptions: [
      { name: \"Backlog\",     color: GRAY,   description: \"\" }
      { name: \"Ready\",       color: BLUE,   description: \"\" }
      { name: \"In Progress\", color: YELLOW, description: \"\" }
      { name: \"In Review\",   color: ORANGE, description: \"\" }
      { name: \"Done\",        color: GREEN,  description: \"\" }
    ]
  }) { projectV2Field { ... on ProjectV2SingleSelectField { id } } }
}" > /dev/null
echo "Status options set"

# ── 8. Priority field ─────────────────────────────────────────────────────────
gh api graphql -f query="
mutation {
  createProjectV2Field(input: {
    projectId: \"$PROJECT_ID\"
    dataType: SINGLE_SELECT
    name: \"Priority\"
    singleSelectOptions: [
      { name: \"P0\", color: RED,    description: \"Critical\" }
      { name: \"P1\", color: ORANGE, description: \"High\" }
      { name: \"P2\", color: YELLOW, description: \"Normal\" }
    ]
  }) { projectV2Field { __typename } }
}" > /dev/null
echo "Priority field created"

# ── 9. Size field ─────────────────────────────────────────────────────────────
gh api graphql -f query="
mutation {
  createProjectV2Field(input: {
    projectId: \"$PROJECT_ID\"
    dataType: SINGLE_SELECT
    name: \"Size\"
    singleSelectOptions: [
      { name: \"XS\", color: GRAY,   description: \"\" }
      { name: \"S\",  color: BLUE,   description: \"\" }
      { name: \"M\",  color: GREEN,  description: \"\" }
      { name: \"L\",  color: YELLOW, description: \"\" }
      { name: \"XL\", color: RED,    description: \"\" }
    ]
  }) { projectV2Field { __typename } }
}" > /dev/null
echo "Size field created"

# ── 10. Estimate field (number) ───────────────────────────────────────────────
gh api graphql -f query="
mutation {
  createProjectV2Field(input: {
    projectId: \"$PROJECT_ID\"
    dataType: NUMBER
    name: \"Estimate\"
  }) { projectV2Field { __typename } }
}" > /dev/null
echo "Estimate field created"

# ── 11. Write and commit project-config.json ──────────────────────────────────
CONFIG=$(gh api graphql -f query="
{
  node(id: \"$PROJECT_ID\") {
    ... on ProjectV2 {
      fields(first: 20) {
        nodes {
          ... on ProjectV2SingleSelectField { id name options { id name } }
        }
      }
    }
  }
}")

STATUS_OPTIONS=$(echo "$CONFIG" | jq '
  .data.node.fields.nodes[]
  | select(.name == "Status")
  | .options
  | map({(.name): .id})
  | add')

cat > .github/project-config.json << JSONEOF
{
  "project_node_id": "$PROJECT_ID",
  "status_field_id": "$STATUS_FIELD_ID",
  "options": $STATUS_OPTIONS
}
JSONEOF

git add .github/project-config.json
git commit -m "chore: add project-config.json"
git push
echo ".github/project-config.json committed"

# ── 13. Set PROJECT_NUMBER Actions variable ───────────────────────────────────
gh variable set PROJECT_NUMBER --repo "$OWNER/$REPO" --body "$PROJECT_NUMBER"
echo "Set Actions variable: PROJECT_NUMBER=$PROJECT_NUMBER"

# ── 14. Branch protection ─────────────────────────────────────────────────────
echo ""
echo "Applying branch protection..."
PROTECTION='{"enforce_admins":true,"required_pull_request_reviews":null,"required_status_checks":null,"restrictions":null,"allow_force_pushes":false,"allow_deletions":false}'
for BRANCH in main stg dev; do
  if echo "$PROTECTION" | gh api "repos/$OWNER/$REPO/branches/$BRANCH/protection" \
      --method PUT --input - > /dev/null 2>&1; then
    echo "Protected: $BRANCH"
  else
    echo "Skipped $BRANCH (may not exist yet)"
  fi
done

# ── 15. Set GH_PAT secret ─────────────────────────────────────────────────────
gh secret set GH_PAT --repo "$OWNER/$REPO" --body "$GH_TOKEN"
echo "GH_PAT secret set"

# ── Done: clean up setup.sh from the new repo ────────────────────────────────
git rm setup.sh
git commit -m "chore: remove setup.sh (one-time setup complete)"
git push

# ── Done ──────────────────────────────────────────────────────────────────────
echo ""
echo "=== Setup complete ==="
echo ""
echo "  Repo:    https://github.com/$OWNER/$REPO"
OWNER_TYPE=$(gh api "users/$OWNER" --jq '.type' 2>/dev/null || echo "User")
if [ "$OWNER_TYPE" = "Organization" ]; then
  echo "  Board:   https://github.com/orgs/$OWNER/projects/$PROJECT_NUMBER"
else
  echo "  Board:   https://github.com/users/$OWNER/projects/$PROJECT_NUMBER"
fi
echo ""
echo "  README.md is yours — update it to describe your project."
echo ""
echo "Next:"
echo "  cd $REPO"
