# Phase 2 — AWS platform engineering and public readiness

_Part of the [delivery roadmap](../ROADMAP.md)._

Phase 2 promotes the MVP to a secure, cost-bounded public project deployed from
GitHub Actions. Infrastructure code and workflows are implemented in this
repository; AWS/GitHub activation and operational rehearsals require the target
accounts and therefore remain release gates.

## P2.1 — Public repository and contribution foundation

- [x] **Task 1.** Add the MIT license, contribution and support guides, code of conduct,
      private security-reporting policy, guided issue forms, pull-request
      template, CODEOWNERS, labels, and release-note configuration.
- [x] **Task 2.** Document the project status, limitations, public-history audit, contributor
      workflow, and GitHub repository settings.
- [x] **Task 3.** Provide an idempotent GitHub configuration script for Discussions,
      security features, branch protection, merge policy, and labels.
- [x] **Task 4.** Rotate the credential found by the 2026-09-02 audit and delete its sole
      containing experimental branch; `main` was never affected.
- [x] **Task 5.** Push the workflows and obtain a clean full-history Gitleaks run.
- [x] **Task 6.** Make the repository public.
- [x] **Task 7.** Apply and verify GitHub security settings and branch protection:
      `scripts/configure-github-repository.sh` enables secret scanning/push
      protection, vulnerability alerts, automated security fixes, private
      vulnerability reporting, read-only default workflow permissions, labels,
      and `main` branch protection (required status checks, linear history, no
      force-push/deletion, required conversation resolution). Verified live via
      the GitHub API on 2026-09-07.
- [ ] **Task 8.** Rehearse an untrusted fork pull request: confirm a read-only token, no
      AWS OIDC role, no GitHub environment/provider secret exposure, required
      checks still run on fork code, and no `pull_request_target` execution.

## P2.2 — Production runtime and container readiness

- [x] **Task 1.** Add pinned, minimal, non-root web and worker images with ARM64 support,
      standalone Next.js output, health checks, and graceful shutdown.
- [x] **Task 2.** Remove build-time secret embedding; use Lambda/ECS/EKS role credentials
      by default and configurable bounded/TLS database connections.
- [x] **Task 3.** Add PR image builds, SBOM generation, and vulnerability gates.
- [x] **Task 4.** Deploy the development Lambda runtime in AWS and pass its live HTTP health
      and readiness checks.
- [ ] **Task 5.** Complete the remaining Lambda asynchronous-path, Fargate, and EKS
      runtime/shutdown demonstrations in the AWS account.

## P2.3 — Terraform foundation and isolated environments

- [x] **Task 1.** Add the encrypted/versioned state and ECR bootstrap root with repository-
      scoped GitHub OIDC roles.
- [x] **Task 2.** Add independently keyed always-live serverless development, just-in-time
      ECS staging, and just-in-time EKS production roots with isolated S3,
      PostgreSQL, SQS, secrets, DNS/TLS, telemetry, budgets, and IAM.
- [x] **Task 3.** Make staging/production runtime resources conditional through
      `environment_active` while retaining their data planes.
- [x] **Task 4.** Bootstrap the target account and apply the development environment.
- [x] **Task 5.** Review real staging/production plans and apply their inactive foundations:
      both roots' persistent foundations (VPC, ACM validation, Aurora, S3, SQS,
      secrets) have been applied and confirmed multiple times this session,
      including the production teardown that resolved the 2026-09-07 incident
      (issues #9, #10).

## P2.4 — GitHub Actions delivery and just-in-time lifecycle

- [x] **Task 1.** Add PR platform/Kubernetes checks, immutable ARM image publishing,
      automatic development and staging delivery, one-off migrations,
      staged-image promotion, manual bounded EKS production activation, hourly
      expiry cleanup, and safe production drain.
- [x] **Task 2.** Add operational drain checking, idempotent queue reconciliation, and cost
      preflight commands.
- [x] **Task 3.** Create all three GitHub environments and configure development OIDC
      variables.
- [x] **Task 4.** Correct the repository plan variables (`AWS_PLAN_ROLE_ARN` is a real IAM
      role ARN; `APP_HOSTNAME` is a real FQDN) and configure staging/production
      OIDC variables.
- [x] **Task 5.** Complete two consecutive staging lifecycle runs: `34080493765` (commit
      `506767e`) and `34081530170` (commit `413fc5f`) both activated
      infrastructure, migrated, deployed, passed HTTP smoke checks, tagged
      `staging-passed-<sha>`, and deactivated cleanly on 2026-09-07.

## P2.5 — Scaling, security, observability, and cost controls

- [x] **Task 1.** Encode distinct Lambda/ECS/Pod Identity roles, worker-only OpenAI access,
      web/worker scaling limits, log retention, SQS alarms, WAF, SNS, and
      environment budgets.
- [x] **Task 2.** Refuse normal production activation beyond $20 unless a break-glass input
      is supplied.
- [x] **Task 3.** Document the threat model, incident response, backup/restore, and inactive
      cost model.
- [ ] **Task 4.** Execute load, failure, authorization, restore, and teardown drills.

## P2.6 — Production rehearsal and completion

- [ ] **Task 1.** Rehearse sign-in, signed upload, AI review, collection/export/deletion,
      scaling, Spot replacement, rollback, reconciliation, cold resume/PITR,
      deactivate/reactivate, expiry cleanup, and an untrusted fork PR.
- [ ] **Task 2.** Publish sanitized architecture, CI/CD, contribution, cost, threat-model,
      load-test, recovery, and runbook evidence.

Phase 2 completes after two consecutive staging lifecycles, one production
rehearsal, and one fork contribution/security rehearsal pass without manual AWS
console changes.
