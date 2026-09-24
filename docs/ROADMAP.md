# Delivery roadmap

This file is the entry point only. Each phase's full detail — task
checklists, exit criteria, and (once work starts) dated completion notes —
lives in its own file under `docs/roadmap/`, split so no single file grows
large enough to be slow to read or to get truncated by a tool with a read
limit. Read this file first for current status and sequencing, then open the
linked file for the phase or milestone you're working on.

Task numbers restart at 1 within each milestone/phase file (e.g. "P3.1 Task
3" and "P4.2 Task 3" are unrelated tasks in different files). Reference tasks
this way in `docs/HANDOFF.md` and elsewhere so they stay unambiguous as items
are checked off.

## Status at a glance

| Phase                                                   | Status                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Detail                                                                     |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Phase 1 — MVP                                           | Complete                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | [phase-1-mvp.md](roadmap/phase-1-mvp.md)                                   |
| Phase 2 — AWS platform engineering and public readiness | Mostly complete; production infrastructure activation/deactivation now passes end to end and issue #8 is resolved; remaining items are manual/maintainer-gated (issues #11-#15)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | [phase-2-platform-engineering.md](roadmap/phase-2-platform-engineering.md) |
| Phase 3 — product maturity and a measured baseline      | Complete except P3.4 Task 4 (issue #20)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | see the P3.1-P3.5 table below                                              |
| Phase 4 — measured service extraction                   | P4.1 implemented, core staging rehearsal now verified live (issue #19 concurrent-caller proof verified live after the Service Connect alias fix). P4.2 complete, core staging rehearsal now verified live (issue #29 authenticated pipeline smoke verified live). P4.3 Tasks 1-3 done — all four Terraform roots and all environment writers are sole-owned by [vinylhound-platform](https://github.com/jessig1/vinylhound-platform); production activation, deactivation, and the final IAM/workflow cutover are verified. Task 4 complete; P4.4 passed its final topology audit with the optional CI runner ECS Exec diagnostic limitation recorded; P4.5 not started | see the P4.1-P4.5 table below                                              |

## Phase 1 — MVP (complete)

The original milestones (0-4) comprise the completed MVP. Deferred per-copy
editing and the formal private AI evaluation remain explicit limitations, not
Phase 2 platform blockers. Full detail:
[phase-1-mvp.md](roadmap/phase-1-mvp.md).

## Phase 2 — AWS platform engineering and public readiness

Phase 2 promotes the MVP to a secure, cost-bounded public project deployed
from GitHub Actions. Infrastructure code and workflows are implemented in
this repository; AWS/GitHub activation and operational rehearsals require the
target accounts and therefore remain release gates. Full detail, including
P2.1-P2.6's task checklists:
[phase-2-platform-engineering.md](roadmap/phase-2-platform-engineering.md).
The remaining manual/maintainer-gated work is tracked in issues #8-#15.

## Phases 3 and 4 — product maturity and measured service extraction

Planned 2026-09-08 from [the plan review](PHASE_3_4_PLAN_REVIEW.md) and
[handoff](HANDOFF.md). This supersedes the former Phase 3 UI/UX and
model-training placeholder. The original draft is not in the repository;
this roadmap translates its recorded intent into deliverables and
incorporates review findings E1-E3 and G1-G11.

Phase 3 completes repeated mobile capture and everyday music organization,
then measures the modular monolith. Phase 4 tests whether selected service
boundaries justify their complexity and cost. Do not claim an architectural
improvement before measuring it. Retaining or returning to the monolith is a
valid outcome.

### Sequence and gates

- Phase 2 remains incomplete, tracked in issues #11-#15. Phase 3 can proceed
  locally and in development without restarting production activation.
- Use local reproducible workloads and staging/ECS for Phase 4 demonstrations.
  Production/EKS activation/deactivation is now verified and issues #8-#10 are
  resolved. The remaining Phase 2 drills and evidence work stay independently
  gated by issues #11-#15.
- Start P3.1, including instrumentation and a preliminary persistent-cost
  inventory, then P3.2/P3.4. P3.3 is independent of capture and the first product
  scope cut if time or budget slips; record a deferral rather than marking it
  complete. Its compatibility foundation remains required before extraction.
- Finish P3.5 after the selected product scope stabilizes. Run P4.1 before P4.2,
  recording a proceed/defer decision at each boundary. P4.3 follows a working
  staging extraction; P4.4 evaluates the final topology. P4.5 can run earlier and
  is mandatory before public application usage or model/cost optimization.
- Keep existing runtime tiers. Development retains in-process implementations
  behind the same ports; staging receives extracted services first. Provide
  production EKS definitions and a gated rehearsal. Additional development
  service Lambdas and new hosting platforms are outside this scope.

### Phase 3 — product maturity and a measured baseline

| Milestone                                                    | Status                             | File                                                                           |
| ------------------------------------------------------------ | ---------------------------------- | ------------------------------------------------------------------------------ |
| P3.1 — Continuous capture and foundations                    | Complete                           | [p3.1-continuous-capture.md](roadmap/p3.1-continuous-capture.md)               |
| P3.2 — Guided automatic mobile capture                       | Complete                           | [p3.2-guided-capture.md](roadmap/p3.2-guided-capture.md)                       |
| P3.3 — Discovery and saved music without scanning            | Complete                           | [p3.3-discovery-saved-music.md](roadmap/p3.3-discovery-saved-music.md)         |
| P3.4 — Complete the everyday experience                      | Complete except Task 4 (issue #20) | [p3.4-everyday-experience.md](roadmap/p3.4-everyday-experience.md)             |
| P3.5 — Reproducible performance, delivery, and cost baseline | Complete                           | [p3.5-performance-cost-baseline.md](roadmap/p3.5-performance-cost-baseline.md) |

### Phase 4 — measured service extraction

Follow ADR-0001's package seams and the measurement gate in
[Architecture](ARCHITECTURE.md). Record boundary, persistence, public-contract,
and provider decisions in ADRs before implementation. Current architecture ADRs
remain authoritative until the corresponding cutover.

| Milestone                                             | Status                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | File                                                                         |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| P4.1 — Extract discovery first                        | Implemented; core staging rehearsal verified live 2026-09-23 (discovery ECS service deployed/stable/smoke-tested); issue #19 open for the remaining discovery-only-rollback and concurrent-caller items                                                                                                                                                                                                                                                                                 | [p4.1-extract-discovery.md](roadmap/p4.1-extract-discovery.md)               |
| P4.2 — Extract scans and asynchronous confirmation    | Complete; core staging rehearsal verified live 2026-09-23 (scan/core migrations 021/022 applied to real Aurora, services stable); authenticated full-pipeline smoke and rollback rehearsal verified live                                                                                                                                                                                                                                                                                | [p4.2-scans-async-confirmation.md](roadmap/p4.2-scans-async-confirmation.md) |
| P4.3 — Separate platform delivery and state ownership | Tasks 1-3 done — all four Terraform roots (including `bootstrap`) and all deploy/deactivation writers are sole-owned by [vinylhound-platform](https://github.com/jessig1/vinylhound-platform); production provisioning, migration, rollout, CloudFront smoke tests, deactivation, and the final IAM/workflow cutover are verified. Task 4 complete: concurrent-caller limiter/cache coordination verified live in staging; optional GitHub-runner ECS Exec transport remains unreliable | [p4.3-platform-delivery.md](roadmap/p4.3-platform-delivery.md)               |
| P4.4 — Verify benefits and costs against the monolith | Tasks 1-3 complete — measurements support keeping discovery (single-replica constraint) and scan/core, but P4.4 is not topology-ready or taggable until P4.3 Task 4 completes its remaining scaling/concurrent-caller demonstration                                                                                                                                                                                                                                                     | [p4.4-verify-benefits.md](roadmap/p4.4-verify-benefits.md)                   |
| P4.5 — Private data and AI baseline                   | Not started                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | [p4.5-private-data-ai-baseline.md](roadmap/p4.5-private-data-ai-baseline.md) |

## Deferred beyond Phase 4

Native apps, streaming playback, recommendations, unconstrained cover detection,
dedicated search infrastructure, and model training remain deferred. A future
Phase 5 is not scheduled by this roadmap; scope it from P3.5/P4.4 measurements
and P4.5 failure analysis rather than assuming training or further extraction.
