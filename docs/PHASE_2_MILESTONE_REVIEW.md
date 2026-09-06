# Phase 2 milestone review: P2.1-P2.4

Reviewed 2026-09-05 against the repository, GitHub configuration and workflow
runs, and the AWS account. Repository implementation is complete for P2.1-P2.4.
The remaining work is account-level administration and live rehearsal, except
for the repository hygiene correction recorded below.

## Status summary

| Milestone | Repository work | Live evidence                                                                                                                                             | Outstanding                                                                                                                         |
| --------- | --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| P2.1      | Complete        | Repeated clean full-history Gitleaks runs; historical filename review found no committed raw images, database dumps, logs, or private evaluation manifest | Finish the visibility/fork audit, make the repository public, and apply/verify repository settings                                  |
| P2.2      | Complete        | All three images build and pass local runtime checks; the development Lambda deployment passes live health/readiness checks                               | Exercise the asynchronous Lambda path and demonstrate Fargate and EKS runtime/drain/shutdown in AWS                                 |
| P2.3      | Complete        | Bootstrap resources and OIDC roles exist; development state and ARM64 Lambdas exist                                                                       | Review staging/production plans, populate their configuration/secrets, and apply their inactive foundations                         |
| P2.4      | Complete        | The three GitHub environments exist; development OIDC delivery has succeeded                                                                              | Replace invalid repository plan placeholders, configure/protect staging and production, and pass two consecutive staging lifecycles |

The repository is currently private. Only
`environments/development.tfstate` exists in the remote state bucket; no ECS or
EKS clusters exist. Successful staging workflow runs to date are configuration
guard skips and do not count as lifecycle rehearsals.

## Manual tasks

Perform these in order. Record sanitized run links, timestamps, outcomes, and
any corrective commits in `docs/HANDOFF.md`.

### P2.1: publish and configure GitHub

1. Finish the visibility-change audit in `docs/PUBLIC_REPOSITORY.md`:
   confirm the private evaluation dataset is still outside Git, confirm the
   repository-authored UI has no third-party visual assets needing separate
   terms, and record the completed audit. The historical filename review found
   only `.env.example` and evaluation source/docs; the rotated historical
   credential remains covered by clean full-history Gitleaks runs.
2. Rehearse an untrusted fork pull request. Verify a read-only token, no AWS
   OIDC role, no GitHub environment or provider secret, required checks on fork
   code, and no `pull_request_target` execution.
3. Change repository visibility to public.
4. Run `./scripts/configure-github-repository.ps1` with an administrator GitHub
   CLI session. It enables Discussions/security controls, normalizes merge
   policy and labels, and protects `main`.
5. Verify CodeQL, dependency review, secret scanning/push protection, private
   vulnerability reporting, required checks, and the documented merge policy.

### P2.2: demonstrate the three AWS runtimes

1. In development, submit a disposable scan and capture evidence that the
   EventBridge publisher, SQS FIFO queue, and analysis Lambda process it. Verify
   partial-batch retry behavior and that no function retains work after its
   invocation ends.
2. During a staging lifecycle, verify the migration task, web and worker
   Fargate tasks, health/readiness checks, worker heartbeat, SQS scaling, clean
   worker drain, and service removal on deactivation.
3. During the production rehearsal, verify EKS Pod Identity, web/worker pods,
   probes and HPA behavior, queue processing, Spot replacement, drain, namespace
   removal, and node/control-plane teardown.

Use disposable test records and sanitized logs; do not publish credentials,
signed URLs, raw images, or secret values.

### P2.3: apply staging and production foundations

1. Replace the repository-level placeholder plan inputs with real values. In
   particular, `AWS_PLAN_ROLE_ARN` must be an IAM role ARN and the staging
   application hostname must be a fully qualified domain name.
2. Supply distinct staging and production CIDRs/hostnames and all variables
   listed in `docs/PUBLIC_REPOSITORY.md`. Review real Terraform plans, including
   the production state-address preservation in ADR-0016.
3. Populate each environment's AWS Secrets Manager containers without printing
   values. Keep provider credentials out of GitHub and Terraform state.
4. Apply staging and production with `environment_active=false` first. Verify
   independent state keys, encrypted/versioned state, isolated data planes,
   budgets/alarms, certificates/DNS, and zero unintended resource replacement.

### P2.4: configure delivery and pass two staging lifecycles

1. Populate the required staging and production environment variables. Confirm
   each deployment role is scoped only to its matching GitHub environment.
2. Add production required reviewers if the repository plan supports them;
   otherwise retain the manual workflow dispatch gate. Restrict deployment
   branches/tags according to the documented release policy.
3. Run the staging workflow twice consecutively from clean commits. Each run
   must activate infrastructure, migrate, deploy, pass HTTP smoke checks,
   create `staging-passed-<sha>` image tags, drain workers, and return to
   `environment_active=false` without console repair.
4. Confirm the scheduled expiry workflow remains a safe no-op while production
   is inactive and later deactivates an expired rehearsal cleanly.

## Repository finding corrected by this review

The prior UI commit accidentally tracked a downloaded AWS CLI installer bundle
under `aws/`, causing the latest CI formatting check to fail. The bundle is now
removed from Git tracking and `/aws/` is ignored. It remains available locally
for the maintainer and is not application source or a project dependency.
