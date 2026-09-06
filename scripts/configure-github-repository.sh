#!/usr/bin/env bash

set -euo pipefail

repository="${1:-jessig1/vinylhound_new}"

if ! command -v gh >/dev/null 2>&1; then
  echo "GitHub CLI (gh) is required." >&2
  exit 1
fi

gh auth status >/dev/null

visibility="$(gh api "repos/${repository}" --jq '.visibility')"
if [[ "${visibility}" != "public" ]]; then
  echo "Complete the history/privacy audit and make ${repository} public before applying public-repository settings." >&2
  exit 1
fi

gh api --method PATCH "repos/${repository}" --input - >/dev/null <<'JSON'
{
  "has_issues": true,
  "has_discussions": true,
  "has_wiki": false,
  "allow_squash_merge": true,
  "allow_merge_commit": false,
  "allow_rebase_merge": false,
  "allow_auto_merge": true,
  "delete_branch_on_merge": true,
  "squash_merge_commit_title": "PR_TITLE",
  "squash_merge_commit_message": "PR_BODY",
  "security_and_analysis": {
    "secret_scanning": { "status": "enabled" },
    "secret_scanning_push_protection": { "status": "enabled" }
  }
}
JSON

for endpoint in \
  vulnerability-alerts \
  automated-security-fixes \
  private-vulnerability-reporting; do
  gh api --method PUT "repos/${repository}/${endpoint}" >/dev/null
done

gh api \
  --method PUT \
  "repos/${repository}/actions/permissions/workflow" \
  --input - >/dev/null <<'JSON'
{
  "default_workflow_permissions": "read",
  "can_approve_pull_request_reviews": false
}
JSON

labels=(
  "bug|d73a4a|Reproducible incorrect behavior"
  "feature|1d76db|Accepted product capability"
  "security|b60205|Public hardening work; vulnerabilities stay private"
  "documentation|0075ca|Documentation-only change"
  "infrastructure|5319e7|AWS, Terraform, containers, CI, or operations"
  "good first issue|7057ff|Approachable for a first contribution"
  "help wanted|008672|Maintainer welcomes contributor help"
  "needs-design|fbca04|Requires scope or design agreement"
  "needs-triage|ededed|Not yet reviewed by a maintainer"
  "blocked|bfdadc|Waiting on a dependency or decision"
  "skip-changelog|ffffff|Exclude from generated release notes"
)

for label in "${labels[@]}"; do
  IFS='|' read -r name color description <<<"${label}"
  gh label create "${name}" \
    --repo "${repository}" \
    --color "${color}" \
    --description "${description}" \
    --force >/dev/null
done

gh api \
  --method PUT \
  "repos/${repository}/branches/main/protection" \
  --input - >/dev/null <<'JSON'
{
  "required_status_checks": {
    "strict": true,
    "contexts": [
      "CI / validate",
      "Security / CodeQL",
      "Security / Secret scan",
      "Security / Dependency review",
      "Platform / Terraform validate",
      "Platform / Container build and scan (web)",
      "Platform / Container build and scan (worker)",
      "Platform / Container build and scan (worker-lambda)"
    ]
  },
  "enforce_admins": false,
  "required_pull_request_reviews": {
    "dismiss_stale_reviews": false,
    "require_code_owner_reviews": false,
    "required_approving_review_count": 0,
    "require_last_push_approval": false
  },
  "restrictions": null,
  "required_linear_history": true,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "required_conversation_resolution": true,
  "lock_branch": false,
  "allow_fork_syncing": true
}
JSON

echo "Configured public repository settings for ${repository}."
echo "Review Settings > Actions and Settings > Environments after configuration."
