# ADR-0027: Scan and core own separate PostgreSQL schemas in one deployment

- Status: Accepted
- Date: 2026-09-19
- Builds on: [ADR-0003](0003-postgresql-access-and-migrations.md),
  [ADR-0005](0005-atomic-scan-confirmation.md),
  [ADR-0009](0009-musicbrainz-primary-catalog.md),
  [ADR-0011](0011-direct-library-management.md),
  [ADR-0013](0013-clerk-authentication.md),
  [ADR-0014](0014-account-export-and-deletion.md),
  [ADR-0025](0025-extract-discovery-first.md)

## Context

Roadmap P4.2 Task 1
(`docs/roadmap/p4.2-scans-async-confirmation.md`) asks to define scan
ownership of scans/images/attempts/reviewed confirmations and core ownership
of catalog/library/copies/favorites/playlists, initially inside one physical
PostgreSQL deployment with separate schemas and credentials, no cross-service
table access, and a documented shared failure boundary — before Task 2
onward touch the outbox, the confirmation transaction, or any FK. This is a
decision-record task, the same shape as P4.1 Task 1: it draws the line, it
does not yet cut every wire crossing it.

`docs/PHASE_3_4_PLAN_REVIEW.md` already examined this specific shape twice.
G9 asked P4.1 to state that discovery is stateless and that canonical
catalog tables stay with core — done by ADR-0025 — but left the scan/core
split itself unstated. G10 warned that because P4.2 keeps one physical
PostgreSQL deployment, the cross-schema foreign keys "will keep working —
which is exactly the trap," and asked P4.2 to decide explicitly whether they
are dropped and the invariant re-implemented in the application. The
review's own "Not recommended for change" section already endorses "one
physical PostgreSQL deployment with per-service schemas and separate
credentials, documented as a shared failure boundary" as the right shape —
this ADR is that documentation, plus the concrete table assignment the
review left open.

**Every table lives in one undivided schema today.** `packages/database/src/schema.ts`
defines fifteen tables with no schema qualifier (Postgres's default
`public`): `users`, `batches`, `scans`, `outbox_messages`, `image_assets`,
`scan_attempts`, `scan_candidates`, `catalog_references`, `albums`,
`releases`, `library_items`, `library_copies`, `playlists`,
`playlist_entries`, `scan_confirmations`. A single set of database
credentials (`DATABASE_URL`, ADR-0003) reads and writes all fifteen.

**Two commands already show where the natural line falls, and where it is
crossed today.** `confirmScan` (`packages/database/src/confirmation-repository.ts:55-275`)
opens one transaction that reads `scans`/`scan_attempts`/`scan_candidates`,
calls `resolveReviewedRelease` (`packages/database/src/release-resolution.ts:65-237`,
which takes an advisory lock at `:72-77` and upserts `albums`/`releases`/
`catalog_references`), inserts `library_items` and `library_copies`
(`confirmation-repository.ts:183-226`), and finally inserts
`scan_confirmations` (`:228-255`) — one transaction across every table in
both candidate boundaries, exactly ADR-0005's design and exactly what
`docs/PHASE_3_4_PLAN_REVIEW.md`'s G9 called "six tables across three
candidate service boundaries." By contrast, `placeLibraryRelease`
(`packages/database/src/placement-repository.ts:30-156`, the `/discover`
no-scan path, ADR-0019) calls the identical `resolveReviewedRelease` and
writes `library_items`/`library_copies` in its own transaction that touches
no scan table at all — proof that catalog+library already function as one
coherent unit independent of scan, which is the "core" half of this ADR's
split.

**Account deletion is the other cross-boundary transaction, and it is the
sharpest illustration of the coupling.** `deleteAccount`
(`packages/database/src/account-repository.ts:211-265`) row-locks `users`,
deletes every `scan_confirmations` row for the user directly (to satisfy
ADR-0011's `restrict` FK before anything else), then deletes the `users` row
itself and lets `scans`, `batches`, `image_assets`, `scan_attempts`,
`scan_candidates` (scan-side) and `library_items`, `library_copies`,
`playlists`, `playlist_entries` (core-side) all cascade from `users.id` —
one transaction spanning both candidate schemas, in the one place the
product has promised is atomic and irreversible (ADR-0014).

**The FKs that will cross the new boundary, named exactly:**

- `scans.user_id`, `batches.user_id`, `scan_confirmations.user_id` →
  `users.id`, `cascade` (`schema.ts:110-112,134-136,725-727`)
- `library_items.confirmed_from_scan_id`, `library_copies.confirmed_from_scan_id`
  → `scans.id`, `set null` (`schema.ts:560-563,607-610`)
- `scan_confirmations.release_id` → `releases.id`, **restrict** — ADR-0011's
  deliberate protection against orphaning confirmation history
  (`schema.ts:732-734`)
- `scan_confirmations.library_item_id` → `library_items.id`, `set null`
  (`schema.ts:738-740`)
- `scan_confirmations.copy_id` → `library_copies.id`, `set null`
  (`schema.ts:741-743`)

`outbox_messages.aggregate_id` → `scans.id`, `cascade`
(`schema.ts:180-182`) is **not** in this list: both tables stay in the same
schema under the assignment below, so this FK is not a boundary crossing.

## Decision

**Table ownership.** Two logical services, `scan` and `core`, own disjoint
sets of the fifteen existing tables:

- **`scan` owns:** `scans`, `batches`, `image_assets`, `scan_attempts`,
  `scan_candidates`, `scan_confirmations`, `outbox_messages`. This is
  exactly the roadmap's "scans/images/attempts/reviewed confirmations,"
  plus `batches` (a pure grouping over scans, ADR-0006, never read by core)
  and `outbox_messages` (the durable record of events `scan` publishes;
  Task 2 generalizes its shape but not its owner).
- **`core` owns:** `users`, `albums`, `releases`, `catalog_references`,
  `library_items`, `library_copies`, `playlists`, `playlist_entries`. This
  is exactly the roadmap's "catalog/library/copies/favorites/playlists" —
  favorites is `library_items.favorited_at`, an attribute rather than a
  table (ADR-0021), so it needs no separate assignment — plus `users`.

**Why `users` goes to core, since the roadmap's Task 1 text does not name
it.** Account lifecycle — JIT provisioning, export, deletion (ADR-0013,
ADR-0014) — is already shaped around "the user's collection and its
provenance," not around scan mechanics; `getAccountExportForUser` and
`deleteAccount` read as core-centric operations that happen to reach into
scan history, not the reverse. Scan needs to know _which_ user a row
belongs to, not to own the account. Once `scan` and `core` are physically
separate (Task 7), `scan`'s `user_id` columns stop being foreign keys into
`core.users` and become plain UUID attributes whose validity is guaranteed
by the authenticated request path that writes them (the same pattern
ADR-0025/Task 2 already uses for service identity: a caller is trusted
because it holds a signed credential, not because a live join proves it) —
not decided or implemented by this task.

**Physical layout.** One PostgreSQL deployment, unchanged — no new
instance, no new Terraform resource. Two Postgres schemas, `scan` and
`core`, replace today's implicit `public` schema. Two least-privilege
database roles (`vinylhound_scan_app`, `vinylhound_core_app`) replace
today's single `DATABASE_URL` credential; each role receives `USAGE` and
table privileges on its own schema only, with no `GRANT` on the other's
schema. This is a role/namespace boundary inside the existing Aurora/local
Postgres instance (ADR-0003, ADR-0015/0016's tiers), not a new piece of
infrastructure.

**No cross-service table access.** Neither role may read or write the
other's tables. This is enforced at the database privilege level — the same
kind of real credential boundary `packages/service-auth` already enforces
for internal HTTP calls (ADR-0025) — not merely a code-review convention.

**The eight FKs named above are a documented, temporary exception, not fixed
by this task.** They remain literal SQL foreign keys for now, because only
one physical database exists and Task 1's own scope is "initially keep one
physical PostgreSQL deployment." Removing them is explicitly later work:
Task 3 (superseding ADR-0005 so `confirmScan` stops writing `core` tables
directly) makes the `cascade`/`set null` pairs pointing from `scan` rows at
`core` rows and back unnecessary; Task 6 (replacing the `restrict` FK with
an application invariant and a durable audit reference, and making account
deletion a retryable workflow instead of one transaction) is where
`scan_confirmations.release_id`'s protection and `deleteAccount`'s ordering
get re-implemented without relying on a cross-schema constraint. This ADR
names the exact eight FKs so that work has a concrete checklist rather than
having to rediscover them.

**Documented shared failure boundary.** Schema and role separation gives
`scan` and `core` independent privilege boundaries and independent migration
review, but not independent availability, for as long as only one physical
deployment exists:

- Both schemas live in one Postgres instance/cluster. An instance-level
  outage, failover, connection-limit exhaustion, or maintenance window
  affects both simultaneously; there is no failure isolation between them
  yet.
- Both schemas share one migration history and one `node-pg-migrate` run
  (ADR-0003) — a migration mistake in one schema can still fail the
  deploy step for both, and neither schema can be migrated on an
  independent schedule.
- The engine does not prevent a single transaction from touching both
  schemas: `GRANT`-based separation only holds if the code that writes
  `scan` rows and the code that writes `core` rows actually connect as
  two different roles through two different connection pools. Until Task 7
  cuts a physical writer split, `apps/web` and `apps/worker` remain single
  processes that could, by a code-review lapse rather than a database rule,
  still open one transaction across both schemas — exactly the shape
  `confirmScan` and `deleteAccount` use today. This boundary is a
  discipline enforced by role credentials and review, not a physical or
  process-level guarantee; that guarantee is what Task 7's writer cutover
  is for.

## Consequences

- Task 2 (generalize the outbox) operates entirely inside `scan`'s
  ownership; nothing here changes its scope.
- Task 3 (supersede ADR-0005) must design `core`'s inbox/completion table
  inside the `core` schema and stop `confirmScan` from writing
  `library_items`/`library_copies` in the same transaction as
  `scan_confirmations` — this ADR's boundary is what makes that necessary;
  it is not performed here.
- Task 6 must resolve the five `scan_confirmations`/`library_items`/
  `library_copies` FKs named above (the `restrict` FK and its `set null`
  siblings) and redesign `deleteAccount` as a durable, retryable,
  authenticated cross-schema workflow rather than the single transaction it
  is today — the exact FKs and the exact transaction this ADR flags as the
  reason.
- No code, migration, or credential changes are made by this task. `scan`/
  `core` schemas, roles, and `GRANT`s are created when Task 7 performs the
  additive-migration/backfill/verify/single-writer cutover this roadmap
  phase already calls for, not before — matching how P4.1 Task 1 was a pure
  decision record ahead of P4.1 Task 2's actual extraction.
- `docs/ARCHITECTURE.md` gains a "Scan and core services" section stating
  this ownership split, mirroring the existing "Discovery service" section
  added for ADR-0025.
- If a future session finds `users` belongs with `scan` instead (for
  example, if scan-side identity turns out to need more than a trusted
  UUID), that is a reversal of this ADR's `users` assignment specifically,
  not of the `scan`/`core` split itself.
