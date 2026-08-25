# Database package

This package will own PostgreSQL migrations, generated database types, repositories, and transaction helpers.

Do not let database row types escape into domain or HTTP contracts. Map rows to domain types at this boundary. The initial schema should implement the entities and invariants in `docs/DOMAIN.md`, including unique idempotency keys and append-only scan-attempt metadata.

Select an ORM/query builder when milestone 1 implements persistence; record that choice in an ADR. Until then, this directory intentionally avoids locking the project to a migration tool.
