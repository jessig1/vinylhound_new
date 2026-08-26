# ADR-0003: Drizzle for PostgreSQL access and SQL-first migrations

- Status: accepted
- Date: 2026-08-25

## Context

Milestone 1 introduces durable scan state and needs type-safe PostgreSQL access,
reviewable migrations, constraint support, and a small operational footprint.
Database row types must stay behind the database package, and migrations must be
safe to run separately from web or worker startup.

## Decision

Use Drizzle ORM with the `node-postgres` driver for typed queries and transaction
helpers. Manage forward-only, checked-in SQL migrations with `node-pg-migrate`.
Keep the TypeScript schema and SQL migrations synchronized in code review. Run
migrations as an explicit deployment/setup step, never implicitly during web or
worker startup and never with schema push in a shared environment.

## Consequences

- PostgreSQL constraints remain explicit and reviewable in ordinary SQL.
- Application queries get inferred TypeScript types without exposing database
  rows as API or domain contracts.
- Deployments can migrate before starting application processes and migration
  execution is transaction- and advisory-lock-protected.
- Schema changes require coordinated edits to SQL and the Drizzle schema; an
  integration test detects drift for exercised tables and constraints.
- The project accepts two focused dependencies instead of a full data platform:
  Drizzle for queries and `node-pg-migrate` for migration bookkeeping.
