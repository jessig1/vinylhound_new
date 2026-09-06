param(
  [string]$Repository = "jessig1/vinylhound_new"
)

$ErrorActionPreference = "Stop"

if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
  throw "GitHub CLI (gh) is required."
}

gh auth status | Out-Null
$repositoryInfo = gh api "repos/$Repository" | ConvertFrom-Json
if ($repositoryInfo.visibility -ne "public") {
  throw "Complete the history/privacy audit and make $Repository public before applying public-repository settings."
}

$settings = @{
  has_issues                 = $true
  has_discussions            = $true
  has_wiki                   = $false
  allow_squash_merge         = $true
  allow_merge_commit         = $false
  allow_rebase_merge         = $false
  allow_auto_merge           = $true
  delete_branch_on_merge     = $true
  squash_merge_commit_title  = "PR_TITLE"
  squash_merge_commit_message = "PR_BODY"
  security_and_analysis      = @{
    advanced_security                = @{ status = "enabled" }
    secret_scanning                  = @{ status = "enabled" }
    secret_scanning_push_protection  = @{ status = "enabled" }
  }
} | ConvertTo-Json -Depth 6

$settings | gh api --method PATCH "repos/$Repository" --input - | Out-Null

foreach ($endpoint in @(
  "vulnerability-alerts",
  "automated-security-fixes",
  "private-vulnerability-reporting"
)) {
  gh api --method PUT "repos/$Repository/$endpoint" | Out-Null
}

$workflowPermissions = @{
  default_workflow_permissions   = "read"
  can_approve_pull_request_reviews = $false
} | ConvertTo-Json
$workflowPermissions |
  gh api --method PUT "repos/$Repository/actions/permissions/workflow" --input - |
  Out-Null

$labels = @(
  @{ name = "bug"; color = "d73a4a"; description = "Reproducible incorrect behavior" },
  @{ name = "feature"; color = "1d76db"; description = "Accepted product capability" },
  @{ name = "security"; color = "b60205"; description = "Public hardening work; vulnerabilities stay private" },
  @{ name = "documentation"; color = "0075ca"; description = "Documentation-only change" },
  @{ name = "infrastructure"; color = "5319e7"; description = "AWS, Terraform, containers, CI, or operations" },
  @{ name = "good first issue"; color = "7057ff"; description = "Approachable for a first contribution" },
  @{ name = "help wanted"; color = "008672"; description = "Maintainer welcomes contributor help" },
  @{ name = "needs-design"; color = "fbca04"; description = "Requires scope or design agreement" },
  @{ name = "needs-triage"; color = "ededed"; description = "Not yet reviewed by a maintainer" },
  @{ name = "blocked"; color = "bfdadc"; description = "Waiting on a dependency or decision" },
  @{ name = "skip-changelog"; color = "ffffff"; description = "Exclude from generated release notes" }
)

foreach ($label in $labels) {
  gh label create $label.name --repo $Repository --color $label.color `
    --description $label.description --force | Out-Null
}

$protection = @{
  required_status_checks = @{
    strict = $true
    contexts = @(
      "CI / validate",
      "Security / CodeQL",
      "Security / Secret scan",
      "Security / Dependency review",
      "Platform / Terraform validate",
      "Platform / Container build and scan (web)",
      "Platform / Container build and scan (worker)"
    )
  }
  enforce_admins = $false
  required_pull_request_reviews = @{
    dismiss_stale_reviews           = $false
    require_code_owner_reviews      = $false
    required_approving_review_count = 0
    require_last_push_approval      = $false
  }
  restrictions                     = $null
  required_linear_history          = $true
  allow_force_pushes               = $false
  allow_deletions                  = $false
  required_conversation_resolution = $true
  lock_branch                      = $false
  allow_fork_syncing               = $true
} | ConvertTo-Json -Depth 6

$protection |
  gh api --method PUT "repos/$Repository/branches/main/protection" --input - |
  Out-Null

Write-Host "Configured public repository settings for $Repository."
Write-Host "Review Settings > Actions and Settings > Environments before making the repository public."
