# Architecture decision records

ADRs capture decisions that are expensive to reverse or easy to forget. Use the next number, state the context and options, record the decision and consequences, and mark superseded records rather than rewriting history.

- [ADR-0001: Modular monolith with asynchronous worker](0001-modular-monolith.md)
- [ADR-0002: AI output is structured, auditable, and reviewable](0002-ai-identification.md)
- [ADR-0003: Drizzle for PostgreSQL access and SQL-first migrations](0003-postgresql-access-and-migrations.md)
- [ADR-0004: Transactional outbox with BullMQ](0004-transactional-outbox-and-bullmq.md)
- [ADR-0005: Atomic scan confirmation and list placement](0005-atomic-scan-confirmation.md)
- [ADR-0006: Batches group independent scans; cancellation does not interrupt in-flight work](0006-batches-as-independent-scans.md)
- [ADR-0007: Normalize images at upload completion, not at analysis time](0007-image-normalization-pipeline.md)
- [ADR-0008: Aggregate provider cost/token usage from stored attempts, in application code](0008-usage-and-cost-aggregation.md)
- [ADR-0009: MusicBrainz is the primary canonical catalog](0009-musicbrainz-primary-catalog.md)
- [ADR-0010: Library relationships and physical copies are separate](0010-library-items-and-physical-copies.md)
