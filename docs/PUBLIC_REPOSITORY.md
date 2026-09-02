# Public repository operations

VinylHound uses an issue-first contribution model. The root community-health
files define contributor-facing behavior; this document covers maintainer-only
GitHub configuration and the visibility-change gate.

## Apply repository settings

First complete and record the visibility-change audit below. Change the
repository to public, then immediately authenticate GitHub CLI as the
repository administrator and run:

```powershell
./scripts/configure-github-repository.ps1
```

The script enables Issues and Discussions, disables the wiki and non-squash
merge methods, enables security features and private vulnerability reporting,
creates the standard labels, restricts default Actions permissions to read,
and protects `main` with required checks. It intentionally requires zero
approvals while there is one maintainer; CODEOWNERS still requests review.
Require one CODEOWNER approval when a second active maintainer is added.
The script refuses to run while the repository is private because several
security and branch-protection capabilities depend on public-repository
availability on GitHub Free.

Create GitHub environments named `staging` and `production`. Configure these
non-secret variables in each environment:

- `AWS_DEPLOY_ROLE_ARN`
- `TF_STATE_BUCKET`
- `ECR_WEB_REPOSITORY`
- `ECR_WORKER_REPOSITORY`
- `VPC_CIDR`
- `DOMAIN_NAME`
- `APP_HOSTNAME`
- `BUDGET_ALERT_EMAIL`

Configure the same state/network/domain values plus `AWS_PLAN_ROLE_ARN` as
repository variables for the trusted pull-request Terraform plan. That plan is
skipped for forks; fork jobs never request an OIDC token or target a GitHub
environment. Keep each deployment role ARN in its matching environment.

Protect production with required reviewers if the repository plan supports
them. The production workflow remains manual even without that paid control.
AWS and provider credentials never belong in GitHub; runtime values live in
AWS Secrets Manager and deployments use GitHub OIDC.

## Visibility-change gate

Before making the repository public:

1. Run the full-history Gitleaks workflow and resolve every finding.
2. Inspect historical filenames for `.env`, database dumps, logs, raw images,
   private manifests, and evaluation results.
3. Rotate any credential that may ever have been committed.
4. Verify that screenshots, icons, fixtures, and fonts have compatible terms.
5. Confirm the private evaluation dataset remains outside this repository.
6. Open a forked pull request and verify it receives a read-only token, no AWS
   OIDC role, no environment, and no provider secrets.
7. Confirm required checks run on forked code without `pull_request_target`.

Record the audit date and result in `docs/HANDOFF.md` before changing
visibility.

## Releases

Use SemVer tags (`v0.x.y` before stability). GitHub generated release notes use
`.github/release.yml`; pull-request labels determine their category. Deployment
uses immutable ECR digests rather than mutable release tags.
