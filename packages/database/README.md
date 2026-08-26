# Database package

This package owns PostgreSQL migrations, Drizzle schema/types, database connection
creation, repositories, and transaction helpers.

Do not let database row types escape into domain or HTTP contracts. Map rows to domain types at this boundary. The initial schema should implement the entities and invariants in `docs/DOMAIN.md`, including unique idempotency keys and append-only scan-attempt metadata.

Schema changes are forward-only SQL migrations managed by `node-pg-migrate`. Keep
the Drizzle schema synchronized with every migration and never use schema push in
shared environments. See ADR-0003 for the decision and tradeoffs.

From the repository root:

```bash
npm run db:migrate
npm run db:migration:create -- descriptive-name
npm run test:database
```

The commands use `DATABASE_URL` from the process environment, falling back to
the repository's ignored `.env` file for local development. Database integration
tests are intentionally separate from `npm run check`, so CI does not need a
PostgreSQL service for unit and static checks.

Scan submission and outbox insertion are one transaction. The worker calls the
outbox dispatch helper, which locks one available row, invokes the queue adapter,
and records either publication or a bounded exponential retry delay.

Analysis deliveries are append-only audit rows keyed by logical scan attempt and
BullMQ delivery number. Ranked candidates reference the successful delivery. The
status projection maps persistence rows into the public polling contract without
exposing provider response IDs or storage identifiers.

Reviewed confirmations create or reuse normalized album/release rows and add or
convert a library item in the same transaction. A stored request fingerprint
supports safe idempotent replay while keeping the selected AI candidate linked to
the human decision.
