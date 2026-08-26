# ADR-0004: Transactional outbox with BullMQ

- Status: Accepted
- Date: 2026-08-25

## Context

Submitting a scan changes durable PostgreSQL state and schedules asynchronous
work in Redis. Writing those systems independently creates a failure window: a
committed `queued` scan could be left without a job, or a retry could create
duplicate jobs and duplicate provider spend.

## Decision

Scan submission writes the scan state and a versioned `scan.analyze.v1` outbox
message in one PostgreSQL transaction. The background process polls pending rows,
publishes them to BullMQ, and then records publication. Publication retries use a
deterministic `scan-{scanId}-attempt-{attemptNumber}` BullMQ job ID.

The queue package validates payloads at enqueue and consumption boundaries.
BullMQ retains completed and failed jobs for bounded periods so a publication
retry can resolve to the existing job. Consumer handlers must still be
idempotent and consult authoritative attempt state before calling a paid provider.

## Consequences

- A Redis outage delays publication without losing the accepted scan.
- A crash after Redis accepts a job can cause redelivery, but the stable job ID
  prevents another live job for that attempt while the retained job exists.
- Pollers use row locks with `SKIP LOCKED`, allowing safe horizontal publisher
  concurrency. The initial implementation holds that short row transaction open
  during Redis publication; a lease-based claim can replace it if measurements
  show lock duration is material.
- PostgreSQL remains the source of truth, while Redis is a retryable delivery
  mechanism with at-least-once failure semantics.
