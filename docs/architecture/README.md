# VinylHound architecture package

This package explains VinylHound to engineering and portfolio reviewers. It
separates what is implemented on `main` from a proposed production target and
the evidence required to justify each step between them.

## Status legend

| Label        | Meaning                                                                                        |
| ------------ | ---------------------------------------------------------------------------------------------- |
| **Current**  | Implemented in the repository and reflected in application code, migrations, or accepted ADRs. |
| **Proposed** | A concrete target for review, not an implemented or accepted infrastructure decision.          |
| **Trigger**  | Measurable evidence that would justify adopting the proposed change.                           |

## Reading path

1. [Current system](01-current-system.md) — C4-style context, containers,
   module boundaries, and the local deployment.
2. [Scan lifecycle](02-scan-lifecycle.md) — upload, durable enqueue, analysis,
   retry, review, and confirmation behavior.
3. [Data architecture](03-data-architecture.md) — current ERD, ownership model,
   audit trail, and invariants.
4. [Target production architecture](04-target-production.md) — a proposed AWS
   reference deployment with explicit trust and network boundaries.
5. [Evolution plan](05-evolution-plan.md) — incremental adoption triggers,
   including post-release catalog reuse and conservative non-album filtering.

The repository's [architecture summary](../ARCHITECTURE.md),
[domain model](../DOMAIN.md), [API contracts](../API.md),
[security notes](../SECURITY.md), and [ADRs](../decisions/README.md) remain the
authoritative detailed references.

## Architecture at a glance

| Concern           | Current                                                                                 | Proposed direction                                                                                          |
| ----------------- | --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Application shape | TypeScript modular monolith with separate Next.js web and Node.js worker processes      | Preserve the two-process boundary; scale web and worker independently before considering service extraction |
| Source of truth   | PostgreSQL                                                                              | Managed, encrypted PostgreSQL with backups and restore testing                                              |
| Asynchronous work | Transactional outbox to BullMQ on Redis                                                 | Managed Redis initially; reconsider transport only if reliability or operating cost data supports a change  |
| Image storage     | S3-compatible MinIO locally; original, analysis, and thumbnail objects                  | Private S3 with lifecycle, retention, deletion, and encryption controls                                     |
| Identification    | OpenAI Responses API plus user-triggered MusicBrainz vinyl search behind provider ports | Add scan-fingerprint reuse and a conservative album-likelihood gate after the MVP is operating              |
| Identity          | One configured development user; persisted rows are already user-scoped                 | Federated identity plus an internal-user mapping, authorization tests, export, and deletion                 |
| Operations        | Local Docker Compose and GitHub Actions validation                                      | Container runtime, infrastructure as code, observability, budgets, quotas, and tested recovery              |

## Architectural position

VinylHound intentionally does not begin as a microservice system. Image
analysis is asynchronous because it is slow, retryable, and billable, but the
domain and persistence model remain one logical application. Package boundaries
provide extraction seams if a component later needs independent ownership,
deployment, or scaling.

The production view is an AWS reference architecture because the implemented
storage port is S3-compatible and the web/worker split maps cleanly to managed
container services. It is a proposal, not a claim that cloud infrastructure
already exists. A provider choice and infrastructure implementation should be
recorded in a new ADR before deployment.

## Scope boundaries

- Album identification and pressing identification remain separate concerns.
- A model or catalog match is a candidate until a user confirms or corrects it.
- MusicBrainz is the accepted primary canonical catalog; Discogs remains a
  deferred, optional pressing cross-check subject to a fresh terms review.
- Cross-user recognition reuse must not expose one user's image or collection
  data to another user.
- Exact-match caching, perceptual matching, and non-album filtering are
  post-release optimizations, not prerequisites for shipping the current MVP.
- Service extraction, Kubernetes, and event-streaming infrastructure require a
  demonstrated scaling or ownership need.
