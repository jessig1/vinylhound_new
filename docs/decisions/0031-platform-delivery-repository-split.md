# ADR-0031: Split platform delivery into a dedicated repository

- Status: Accepted (decision record only — no repository created, no OIDC
  trust changed, no file moved by this ADR)
- Date: 2026-09-22
- Builds on: [ADR-0025](0025-extract-discovery-first.md),
  [ADR-0026](0026-discovery-coordination-substrate.md),
  [ADR-0027](0027-scan-core-schema-ownership.md),
  [ADR-0030](0030-scan-core-physical-split.md)

## Context

Roadmap P4.3 Task 1 (`docs/roadmap/p4.3-platform-delivery.md`): "move
platform configuration/delivery into a dedicated platform repository. Keep
immutable service-specific application artifacts, narrow OIDC roles,
previous-contract compatibility, and Phase 3 affected-workspace
improvements." This is a decision-record task, the same shape as P4.1 Task 1
and P4.2 Task 1 (ADR-0025, ADR-0027): it draws the line the later P4.3 tasks
cut along, and commits to no infrastructure or repository change itself.

**Starting Task 1 ahead of its stated prerequisite, recorded explicitly.**
`docs/ROADMAP.md`'s "Sequence and gates" note says "P4.3 follows a working
staging extraction." Neither P4.1's nor P4.2's own live staging rehearsal has
been run yet (issue #19; P4.2's is tracked separately per
`docs/roadmap/p4.2-scans-async-confirmation.md`) — both need real AWS access
and GitHub environment permissions no agent session can use unilaterally.
`docs/HANDOFF.md`'s resume point already noted the precedent this repeats:
P4.1 Task 1 and P4.2 Task 1 were both started ahead of their own sequence
note's stated prerequisite, at the maintainer's explicit direction, and
recorded as such rather than silently skipped. This session proceeds the
same way, at the maintainer's explicit direction (asked directly to start
"P4.3 task 1"): this ADR is pure documentation of the target shape and
carries no infrastructure risk, so it does not need the staging rehearsal to
precede it. P4.3 Task 2's inventory and, especially, Task 3's actual state/
writer transfer remain gated on closing issues #9/#10 exactly as the roadmap
already requires — this ADR does not relax that gate, only Task 1's own
paper work proceeds early.

**Current platform delivery surface, as it exists today** (verified by
reading the source, not assumed):

- **Four Terraform roots** under `infra/terraform/`: `bootstrap` (S3 state
  bucket, four `IMMUTABLE`-tag ECR repositories, the GitHub OIDC provider,
  and every IAM role below), `development` (S3 backend, always-on Lambda/API
  Gateway/SQS environment), `environment` (S3 backend, the scale-to-zero ECS
  staging root — `var.environment` also historically named a generic
  concept, but only staging uses it today), and `production` (S3 backend,
  the on-demand EKS/CloudFront root, activated per demo window via SSM
  flags). Each non-bootstrap root's backend bucket/key/region are supplied
  at `terraform init` time by the calling workflow
  (`environments/<name>.tfstate`), not hardcoded in the root.
- **Seven workflows** in `.github/workflows/`: `ci.yml` and `security.yml`
  are pure CI (lint/typecheck/test/build, contract compatibility, CodeQL,
  Gitleaks) with no AWS credentials at all. `platform.yml` validates/plans
  all four Terraform roots on PRs and builds (never pushes) all four service
  images for a Trivy scan. `deploy-development.yml`, `deploy-staging.yml`,
  and `deploy-production.yml`/`deactivate-environment.yml` each mix two
  concerns in one file: building/pushing service images (development and
  staging only; production never rebuilds) and applying their respective
  Terraform root plus deploying (Lambda env vars, ECS services, or
  `kubectl apply`).
- **OIDC roles are narrow along one axis only.** `vinylhound-github-plan`
  (read-only plus state-lock writes) is genuinely narrow and trusted for any
  PR or `main` push. But the three `vinylhound-github-<env>-deploy` roles —
  though correctly separated per environment via GitHub's `environment:`
  subject claim — all share one identical, broad, wildcard-heavy inline
  policy (`ec2:*`, `ecs:*`, `eks:*`, `ecr:*`, `s3:*`, `iam:CreateRole`,
  `rds:*`, `secretsmanager:*`, ... on `Resource = "*"`,
  `infra/terraform/bootstrap/main.tf`). A compromised or misused staging
  deploy job can act on anything production's role could. Every trust policy
  is also pinned to this repository's exact numeric GitHub owner/repo ID
  (`github_oidc_subject_prefix`, `bootstrap/variables.tf`) — a repository
  split requires new trust subjects regardless of any other change.
- **Immutable artifacts and a promotion contract already exist.** ECR's
  `image_tag_mutability = "IMMUTABLE"` makes a pushed tag permanent. Staging
  tags an image `${sha}-staging`, reuses it by digest on retry instead of
  rebuilding, and — only after its own smoke test passes — re-tags the exact
  same digest `staging-passed-${sha}`. Production never builds: it resolves
  `staging-passed-<commit_sha>` by digest and feeds that digest straight into
  each Terraform root's `TF_VAR_*_image` inputs. This digest-promotion
  handoff is the one genuine "deploy-time contract" between workflows today,
  distinct from `packages/contracts`' API/event contract (`check:contracts`,
  ADR-0022), which is unaffected by any of this and stays entirely within
  the application repository. Development is the one exception to the
  promotion pattern: it builds `web`/`worker-lambda` fresh on every push,
  independently of staging's build of the same source.
- **`scripts/affected/`'s build/test scoping (P3.5 Task 5,
  `docs/OPERATIONS.md`) is git-diff-based and already treats `infra/` as a
  safe-ignore path**, not a workspace it scopes into. It reads no workflow
  file content and is not coupled to Terraform or deploy-workflow location;
  moving those out of this repository does not change what it selects or how
  it runs inside `ci.yml`.

## Decision

**What moves to a new platform repository.** All four Terraform roots
(`infra/terraform/bootstrap`, `development`, `environment`, `production`),
`infra/kubernetes/**`, and every workflow step that applies Terraform,
deploys (Lambda env injection, ECS service update, `kubectl apply`), or
runs the production/development/staging smoke tests and DB migrations that
follow a deploy. `platform.yml`'s Terraform validate/plan job moves
entirely; its container-build-and-scan job does not (see below). The state
bucket and its objects are not relocated by this decision — only which
repository's OIDC-authenticated workflow is authorized to write to them
changes, which is P4.3 Task 3's job, not this ADR's.

**What stays in the application repository — "immutable service-specific
application artifacts."** Every `Dockerfile.*`, all application source, and
the step that builds, scans, and pushes each service image stay owned by
the repository that owns the code the image is built from. This is a
narrower, more explicit version of the build-once/promote-by-digest pattern
staging and production already use for `web`/`worker`/`discovery`: the
platform repository never builds an image, never needs write access to
application source, and never needs Docker build context — it only ever
consumes an already-built, already-scanned, immutable digest by tag,
exactly as `deploy-production.yml` already consumes `staging-passed-<sha>`
today. Concretely, the application repository keeps: `ci.yml`, `security.yml`
(unaffected), and a new build-and-push workflow that consolidates today's
build/push steps from `deploy-development.yml` and `deploy-staging.yml`
(tag `${sha}` and `${sha}-staging` respectively) without their Terraform-
apply or deploy steps. Development's fresh-build-on-every-push exception is
kept as-is — unifying it with staging's build is a separate, later decision
this ADR does not make.

**How the two repositories hand off.** The platform repository's staging and
production deploy workflows are triggered with a commit SHA as input — the
same shape `deploy-production.yml` already uses today (`workflow_dispatch`
with a required `commit_sha`) — rather than by a path-filtered push trigger
inside one repository. A cross-repository `repository_dispatch` (or an
equivalent manually-dispatched call carrying the SHA) replaces the
same-repository `workflow_call`/`push` triggers `deploy-development.yml`
currently uses to chain off `ci.yml`. The platform repository's workflows
resolve images by tag/digest exactly as today (`${sha}-staging`,
`staging-passed-<sha>`) and never need to check out application source.

**Narrow OIDC roles — two axes, not one.** Splitting the repositories is the
natural point to finish narrowing what was already identified as
insufficiently narrow, not just relocate it:

1. A new, narrow application-repository role scoped to exactly `ecr:*`
   actions on the four named ECR repositories (and the Trivy/SBOM steps'
   existing permissions) — nothing else. It replaces the application
   repository's current use of the broad per-environment deploy role for
   the image-push step, which today grants far more than a build/push job
   needs.
2. The platform repository keeps three per-environment deploy roles, trusted
   for the platform repository's OIDC subject instead of the application
   repository's, and each narrowed to the specific AWS services its own
   Terraform root actually manages — development scoped to Lambda/API
   Gateway/SQS/Secrets Manager, staging scoped to ECS/RDS/SQS/Secrets
   Manager, production scoped to EKS/RDS/CloudFront/ACM/Secrets Manager —
   replacing today's one identical wildcard policy shared by all three.
   `vinylhound-github-plan` moves with them, trust updated the same way; its
   existing scope is already narrow and does not otherwise change.
   `bootstrap`'s `github_oidc_subject_prefix` becomes two prefixes (one per
   repository), since `bootstrap` itself — being Terraform — moves to the
   platform repository but must still be able to create a role trusted by
   the application repository's subject.

**Previous-contract compatibility — the deploy-time contract, preserved
exactly.** The platform repository's workflows are a drop-in replacement for
today's Terraform-apply/deploy steps, not a redesign: the ECR `IMMUTABLE`
tag policy, the `${sha}` / `${sha}-staging` / `staging-passed-<sha>` tagging
scheme, each Terraform root's `TF_VAR_*_image` input names, and each root's
existing outputs (state bucket, ECR URLs, role ARNs, `application_url`,
`db_cluster_identifier`, etc.) all stay byte-for-byte the same. Nothing about
this split forces an image rebuild, a Terraform resource replacement, or a
state migration — those effects, if any, belong to Task 3's rehearsed
transfer, not to renaming which repository issues the API calls.
`packages/contracts`' API/event compatibility mechanism (`check:contracts`,
ADR-0022) is a separate, already-solved concern and needs no change here.

**Phase 3 affected-workspace improvements — unaffected, kept as-is.**
`scripts/affected/`, `ci.yml`'s `checks`/build jobs, and the safe-ignore list
(which already treats `infra/` as ignored rather than scoped) stay in the
application repository exactly as P3.5 Task 5 left them. Moving
`infra/terraform` and `infra/kubernetes` out of this repository does not add
or remove a workspace the script needs to special-case; if anything it
removes one directory from the ignore list's reason to exist, harmlessly.

## Consequences

- P4.3 Task 2 (inventory the four Terraform roots' backend keys, locks, IAM
  trust, configuration, and owning workflows; close #9/#10 before any
  ownership transfer) has this ADR's "current state" section as a starting
  point but still must do its own full accounting — this ADR describes the
  target shape, not a completed inventory.
- P4.3 Task 3 (rehearse development first, then transfer remaining roots
  individually, each verified with an unchanged plan and a rehearsed
  rollback) is where the new platform repository is actually created, the
  Terraform roots actually move, and the narrowed OIDC roles from this
  decision are actually applied — none of that happens in this ADR. Task 3
  must not recreate resources or create competing state authorities, per the
  roadmap's own exit criteria.
- P4.3 Task 4 (demonstrate independent service delivery, scaling, health,
  migration, rollback, and activation/deactivation in staging) depends on
  Task 3 being complete; production rehearsal stays gated on the unresolved
  Phase 2 issues (#8-#10), unchanged by this ADR.
- `docs/ARCHITECTURE.md` gains a short "Platform delivery repository" note
  describing this target split, mirroring the existing "Discovery service"
  and "Scan and core services" sections.
- No code, workflow, Terraform, or IAM change is made by this task — the new
  repository, its workflows, and the narrowed OIDC roles are created when
  Task 3 performs the rehearsed transfer this ADR's decision describes, not
  before, matching how ADR-0025 and ADR-0027 were pure decision records
  ahead of their own roadmap's later implementation tasks.
