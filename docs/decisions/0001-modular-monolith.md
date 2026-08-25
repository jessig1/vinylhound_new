# ADR-0001: Modular monolith with asynchronous worker

- Status: accepted
- Date: 2026-08-24

## Context

VinylHound begins as a personal project but image uploads, provider latency, and batch processing must not block web requests. Premature microservices would add deployment, networking, and data-consistency costs.

## Decision

Use one TypeScript monorepo and one logical application, deployed initially as a web process plus an asynchronous worker. PostgreSQL is authoritative, Redis is the job transport, and images live in S3-compatible storage. Shared packages enforce boundaries and are potential future extraction seams.

## Consequences

- Local setup includes three infrastructure dependencies but production concerns remain familiar.
- Slow work can retry and scale independently from web traffic.
- Cross-module changes remain simple and transactional.
- Code review must enforce boundaries because packages share a repository.
- A transactional outbox/equivalent is required when durable enqueueing is implemented.
