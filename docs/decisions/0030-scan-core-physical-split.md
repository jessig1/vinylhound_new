# ADR-0030: Scan and core become physically separate Postgres schemas and roles; the writer switch drops the remaining cross-schema FKs

- Status: Accepted
- Date: 2026-09-21
- Completes: [ADR-0027](0027-scan-core-schema-ownership.md)
- Amends: [ADR-0028](0028-async-scan-confirmation.md) ("Left to Task 7"), [ADR-0029](0029-durable-account-deletion-and-release-id-policy.md) ("Left to Task 7")
- Builds on: [ADR-0011](0011-direct-library-management.md), [ADR-0018](0018-removable-library-items.md), [ADR-0023](0023-full-library-search-and-keyset-pagination.md)

## Context

Roadmap P4.2 Task 7 (`docs/roadmap/p4.2-scans-async-confirmation.md`), the
final task of P4.2: "Use additive migrations, backfill, verification, then a
single writer switch. Test rollback with in-flight events and
reconciliation; never enable two authoritative writers." ADR-0027 (Task 1)
named the table split and the eight FKs that would cross it, and explicitly
deferred creating any schema, role, or GRANT to this task. Tasks 2-6 removed
every structural reason `confirmScan`'s and `deleteAccount`'s transactions
needed to touch both sides in one transaction, but the two roles, the two
schemas, and the physical connection split itself did not exist until this
task.

**The real scope turned out larger than ADR-0027's own text implied**, for
three reasons found while designing this, not assumed going in:

1. **`confirmation_receipts` is a sixteenth table**, not one of ADR-0027's
   fifteen — it did not exist when that ADR was written (P4.2 Task 3 added
   it afterward) and its own doc comment already says "core-owned per
   ADR-0027," so it belongs in the count.
2. **Two cross-schema reads were not on ADR-0027's list at all**:
   `confirmScan`'s `users.deletion_requested_at FOR SHARE` check (added by
   Task 6/ADR-0029, after ADR-0027 was written) reads a `core` table from
   what is otherwise an entirely `scan`-owned transaction; and
   `library-repository.ts`'s main listing query joins
   `scan.scan_confirmations` into a `core.library_items` read to get the
   artist/title a user corrected and to sort/search by it (ADR-0012,
   ADR-0023). Both are real, load-bearing reads with no room in a hard
   role/schema boundary.
3. **Postgres does not actually stop enforcing a cross-schema FK when the
   two sides become different roles** — a referential-integrity check runs
   with the referenced table's owner rights, not the connecting role's, so
   the eight FKs ADR-0027 named would keep silently working after a naive
   schema/role split. ADR-0027's "no cross-schema GRANT and therefore no
   cross-schema FK at all" is the right architectural target, not a fact
   Postgres enforces for free — this ADR is what actually removes them, and
   until it does, they are a real, exploitable gap, not a formality.

## Decision

### Two schemas, two roles, in one additive migration (021)

`CREATE SCHEMA scan`, `CREATE SCHEMA core`; every scan-owned table (`scans`,
`batches`, `image_assets`, `scan_attempts`, `scan_candidates`,
`scan_confirmations`, `outbox_messages`) and every core-owned table
(`users`, `albums`, `releases`, `catalog_references`, `library_items`,
`library_copies`, `playlists`, `playlist_entries`, `confirmation_receipts`)
moves with `ALTER TABLE ... SET SCHEMA` — a catalog-only rename, not a data
rewrite, and reversible by the identical statement in the other direction.
Two new least-privilege roles, `vinylhound_scan_app`/`vinylhound_core_app`,
are `GRANT`ed `USAGE` and table privileges on their own schema only, with an
explicit `REVOKE ALL` on the other's — the actual privilege boundary
ADR-0027 described. `packages/database/src/schema.ts`'s `pgTable`
declarations stay unqualified (no `pgSchema()`): each pool sets its own
`search_path` via a new `DatabaseOptions.searchPath` field forwarded as the
connection's startup `options` (`scan,public` or `core,public`), chosen over
relying on `ALTER ROLE ... SET search_path` alone because that only takes
effect for a connection opened after the change — production's rolling
Kubernetes deploy keeps old and new pods on the same database mid-rollout.
`ALTER DATABASE <current> SET search_path = scan, core, public` (resolved via
`current_database()` inside a `DO` block, since `ALTER DATABASE`/`ALTER ROLE
... IN DATABASE` both require a literal name — a hardcoded `vinylhound`
would silently no-op against any differently named database, exactly the
bug a real run of the e2e suite's own `vinylhound_e2e` database caught) is
kept too, as the default for the master/migration role and any ad hoc
`psql` session.
The two roles' passwords are parsed out of `SCAN_DATABASE_URL`/
`CORE_DATABASE_URL` by a new `ensureDatabaseRoles`
(`packages/database/src/roles.ts`) run immediately before the migration
itself, from `packages/database/src/migrations.ts` — a plain `.sql`
migration cannot read environment variables, and a literal password in a
versioned migration file would be a committed secret. Every migration
entry point in the repo (`packages/database/scripts/migrate.ts`, now what
`npm run db:migrate` actually runs instead of invoking `node-pg-migrate`'s
CLI directly; `apps/worker/src/migrate.ts` for staging/production) goes
through this same function, so role bootstrap can never be skipped.

Migration 021 also backfills the two structural additions the writer switch
needs (below) while a single migration connection can still see both
schemas at once, and is deliberately **behavior-neutral by itself**: every
FK survives it unchanged (point 3 above), so it can be applied, and the
application redeployed onto the two new connections, before anything
irreversible happens.

### The writer switch (migration 022) drops all eight FKs

Applied only after the application redeploy that reads and writes through
`ScanDatabase`/`CoreDatabase` (below) is live — never before, and never
with both a pre-cutover and post-cutover version of the code running against
the database at once, per the roadmap's "never enable two authoritative
writers." Each dropped FK's replacement:

- `scans.user_id`, `batches.user_id`, `scan_confirmations.user_id` →
  `users.id` cascade: become plain UUID attributes (ADR-0027's own
  prediction). The cascade delete they provided is replaced by
  `deleteScanDataForUser`'s explicit, ordered delete (see below).
- `library_items.confirmed_from_scan_id`, `library_copies.confirmed_from_scan_id`
  → `scans.id` set null: become fixed audit references. **A deliberate
  behavior change**: deleting a scan no longer nulls these columns. Nothing
  user-visible depends on the old nulling — display already reads
  `library_items.confirmed_release` (below), not a live join through this
  id — and no code path deletes a `scans` row today outside account
  deletion, which now deletes the referencing `library_items`/`library_copies`
  rows in the same pass (core cascades from `users`, unaffected by this
  task).
- `scan_confirmations.release_id` → `releases.id` set null: dropping this FK
  removes its `ON DELETE SET NULL` action entirely, which is also what used
  to _trigger_ `scan_confirmations_status_consistency_check` (ADR-0029) on a
  completed row and block the delete with a `23514` error — that protection
  only ever fired because the FK's `SET NULL` ran the `UPDATE` the check
  then rejected. With the FK gone, deleting a `releases` row now succeeds
  unconditionally, leaving a dangling, unenforced `release_id` on any
  confirmation that named it. This is safe only because no code path
  deletes a `releases` row today (confirmed by search, matching ADR-0029's
  own finding); if one is ever written, it must preserve the audit row
  itself (`reviewed_release`/`payload` keep the original values regardless
  of what `release_id` degrades to) since the database no longer enforces
  anything here at all.
- `scan_confirmations.library_item_id`/`copy_id` → `library_items`/
  `library_copies` set null: this is the one FK whose removal is user-visible
  if left unreplaced (see ADR-0018 below).

New indexes replace what each dropped FK implicitly backed:
`scan_confirmations (user_id, status)` (the deletion workflow's own
readiness check), `library_items (confirmed_from_scan_id) WHERE ... IS NOT
NULL`, and `outbox_messages (aggregate_id) WHERE published_at IS NULL`
(cleanup and reconciliation still filter by these).

### Two connections, everywhere: `ScanDatabase`/`CoreDatabase`

`packages/database/src/database.ts` gains branded `ScanDatabase`/
`CoreDatabase` types (`createScanDatabase`/`createCoreDatabase`,
`scanDatabaseOptionsFromConfig`/`coreDatabaseOptionsFromConfig`) so the
compiler — not just code review — flags a function called with the wrong
role's connection. `createDatabase`/`databaseOptionsFromConfig` remain, for
the master/migration connection only. Thirteen of nineteen files in
`packages/database/src` needed only this mechanical retyping (their queries
already touched one schema exclusively); six needed real logic changes,
covered below. `apps/web`'s `ServerContext.database` becomes
`{ scan, core, close }` instead of one pool (`context.ts`); `apps/worker`
constructs both at module scope in every entry point
(`index.ts`/`lambda.ts`/`e2e-worker.ts`/`ops.ts`) and routes each handler,
dispatch loop, and sweep to the connection matching the table(s) it
touches — this is where "never two authoritative writers" becomes visible
in code, not just policy: the confirmation-processing handler physically
cannot reach `scan_confirmations`, and the completion handler physically
cannot reach `library_items`, because neither role has a grant on the
other's schema.

### `confirmScan`'s account-deletion check: a scan-local tombstone

`confirmScan` used to read `core.users.deletion_requested_at FOR SHARE`
(ADR-0029) to refuse a new confirmation once an account's deletion had been
requested. It cannot read a `core` table at all once the GRANT boundary is
real. Migration 021 adds `scan.account_deletions (user_id, requested_at)`,
backfilled from every already-deletion-requested `core.users` row; `DELETE
/api/v1/account` writes a row here (on the scan connection) _before_ marking
`core.users` (on the core connection) — the fail-safe direction is
"confirmations are refused slightly before the account is actually being
deleted," never the reverse.

### Account deletion becomes two ordered, idempotent phases

`deleteAccount`/`finalizeAccountDeletion` (`account-repository.ts`) no
longer share one transaction across both schemas (impossible now) or even
one connection. **Phase 1, `deleteScanDataForUser` (scan connection):**
locks every existing scan row for the user `FOR UPDATE` first — this is what
serializes against a concurrent `confirmScan` for one of those scans, which
locks that one scan row before inserting its own `pending` confirmation;
either this blocks behind it and then observes the committed `pending` row
in the recheck that follows, or it wins the race and the blocked
`confirmScan` later finds the scan gone (`not_found`). Only once that lock
is held does it recheck "zero `pending` `scan_confirmations`" — not ready
otherwise, returned to the caller as `{ ready: false }` — and only then
deletes the user's scan-owned rows (plus every `outbox_messages` row naming
one of those scans, fixing a real, independent, pre-existing bug found while
building this: `outbox_messages.aggregate_id` has had no FK since migration
018, so an account's undelivered outbox rows already survived the old
single-transaction delete and would fail forever once dispatched against a
scan that no longer existed). **Phase 2, `deleteCoreDataForUser` (core
connection):** a plain `DELETE FROM users`, needing no further lock or
recheck — once phase 1 reports `ready`, no scan exists to confirm for this
user, so a new `pending` confirmation is provably impossible before phase 2
runs, regardless of the gap between the two calls. The scan-side tombstone
is cleared, best-effort, after phase 2 commits.

**Why this closes the race without reproducing the bug ADR-0029 fixed**: the
original single-transaction design's risk was hard-deleting `users` while a
`scan.confirmed.v1` event could still reach `processScanConfirmation` and
insert against a vanished `user_id`. That is now structurally impossible:
phase 1 will not report ready while any confirmation for the user is
`pending`, and `processScanConfirmation` never observes a `userId` whose
`core.users` row is gone, because phase 2 (the only thing that removes it)
never runs until phase 1 has confirmed there is nothing left in flight.
`listAccountsReadyForDeletion` is renamed `listAccountsPendingDeletion`
(core-only: every account with a deletion request, not pre-filtered by
readiness) since readiness is now `deleteScanDataForUser`'s own job, checked
fresh on every sweep attempt.

### ADR-0018 gets a real replacement, not just a retyped FK

Dropping `scan_confirmations.library_item_id`/`copy_id`'s FKs removes the
`ON DELETE SET NULL` that used to make "the saved record was removed, so the
confirmation reads as unconfirmed and reviewable again" (ADR-0018)
instantaneous and atomic with the delete. `library-repository.ts`'s
`deleteLibraryItem`/`deleteLibraryCopy` now best-effort null the
corresponding `scan_confirmations` column directly on the scan connection,
immediately after their own core transaction commits — not atomic with it
by construction, since it is a second write on a different connection.
`confirmation-repository.ts` covers the resulting window: `getScanConfirmationForUser`
and `confirmScan`'s own supersede check now verify liveness explicitly
(`isLibraryItemRemoved`, a `core` lookup) instead of trusting a stored null,
and self-heal (best-effort null-back) the first time a stale reference is
observed on read. A crash between the two writes therefore cannot leave a
confirmation permanently wrong — the next read (or confirm attempt) reads
the true, live state and repairs the stored one to match, exactly the "durable
state is authoritative, the derived column is a cache of it" posture
ADR-0028's reconciliation sweep already established for the confirmation
pipeline itself.

### Cross-schema reads: compose in memory, or denormalize and backfill

Three reads that used to be one SQL join now issue two queries (one per
connection) and merge in application code, since no cross-schema `ORDER BY`
or transaction exists to join them server-side: `getAccountExportForUser`'s
confirmation→library-item `list` lookup, `listScanSummariesForUser`'s
identical lookup, and `attachCopiesAndSerialize`'s cover-image lookup
(`imageAssets`, scan-owned, keyed by a core row's `confirmedFromScanId`).

**`library-repository.ts`'s main listing query could not take this shape**:
`ORDER BY`/keyset-pagination and the search `ILIKE` (ADR-0023) evaluate the
effective artist/title over the _whole_ library in one SQL statement, which
two separate connections cannot do together. Migration 021 adds
`core.library_items.confirmed_release JSONB` — the identical shape already
stored as `scan.scan_confirmations.reviewed_release` (both now type
`ReviewedRelease`, a hoisted, shared interface so the two columns cannot
drift), written by `processScanConfirmation` directly from the
`scan.confirmed.v1` event payload it already receives (`ScanConfirmedEventSchema`
spreads the identical `ReviewedReleaseShape`, so this needs no read of its
own, cross-schema or otherwise) and backfilled once, in migration 021, from
existing `scan_confirmations` rows while a single connection can still see
both schemas. `effectiveArtist`/`effectiveTitle` and the serializer read
this column instead of joining `scan.scan_confirmations`; every existing
sort/search/pagination behavior is unchanged, proven by the existing test
suite passing unmodified in shape (only its call signatures changed).

### JIT user provisioning relocates to where it belongs

`ensureDevelopmentUser`/`getOrCreateUserIdByClerkId` lived in
`scan-repository.ts` only because scan endpoints happened to be the first
authenticated request in a capture session; `users` is core-owned. Moved
verbatim to a new `user-repository.ts`, taking `CoreDatabase`, called from
`apps/web/src/server/auth.ts` with `context.database.core`.

## Rollback

`node-pg-migrate` (v9, installed) supports a `-- Up Migration`/
`-- Down Migration` marker pair inside one `.sql` file — this repository's
first twenty migrations never used it (nothing before this task needed a
real down path), so this is a new convention, not a break from one. Both
021 and 022 carry a down section: 022's re-adds all eight FKs `NOT VALID`
(so a row orphaned while they were absent cannot make the rollback itself
fail; `VALIDATE CONSTRAINT` afterward, once any such row is reconciled,
restores full enforcement) and drops the three new indexes; 021's moves
every table back to `public`, drops `library_items.confirmed_release` and
`scan.account_deletions`, and resets every `search_path`. Roles are left in
place on rollback (they own nothing, and `ensureDatabaseRoles` re-applies
them harmlessly on the next forward run). A rollback drill — seed a
`pending` confirmation, an undelivered `scan.confirmed.v1` outbox row, and
an undelivered `confirmation_receipts` row; migrate down through both
steps; confirm zero data loss and that `FOR UPDATE VALIDATE`-once restores
full FK enforcement; confirm the existing reconciliation sweep still
recovers the seeded in-flight state against the rolled-back single-schema
layout — is documented as a runbook in `docs/OPERATIONS.md` and exercised
locally as part of this task's own verification, satisfying the roadmap's
"test rollback with in-flight events and reconciliation."

**P4.3 Task 4 (2026-09-23) re-ran this drill against the local dev
database's own real, accumulated data (months of prior testing, not a
fresh database) and found one gap this ADR's own description above
doesn't account for**: 021's down migration unconditionally drops
`scan.account_deletions`, but its up migration only repopulates it from
`core.users` rows that currently have `deletion_requested_at` set. An
account whose deletion had already **fully completed** before the rollback
(its `core.users` row already gone — this table's whole purpose per the
section above is to survive exactly that) has no source row left to
re-derive its tombstone from, so a rollback/roll-forward cycle permanently
loses historical completed-deletion audit records, even though no
in-flight data is touched. Confirmed directly: 3 such rows existed before
the drill (from unrelated prior sessions' completed-deletion testing), 1
after a full rollback and forward re-apply (only the drill's own
still-pending deletion survived). The original local drill never exercised
this, since its own seeded deletion request was still pending when it
checked the table. Not fixed as part of this task — this table reads as an
internal audit aid rather than user-facing state, but the loss is real and
worth a conscious call rather than a silent gap; see `docs/OPERATIONS.md`'s
rollback runbook for the same finding in more detail.

## Consequences

- `docs/ARCHITECTURE.md`'s "Scan and core services" section is updated to
  state the split is now physical, not just a documented convention, and to
  correct ADR-0027's "no cross-schema GRANT and therefore no cross-schema
  FK at all" for the Postgres nuance this ADR's Context section names
  (referential-integrity checks run with the referenced table's owner
  rights, so the FKs kept working until migration 022 removed them on
  purpose — the GRANT boundary alone was never going to do it).
- `docs/roadmap/p4.2-scans-async-confirmation.md`'s Task 7 checkbox closes
  P4.2 entirely; `docs/ROADMAP.md`'s two P4.2 status rows update to reflect
  that.
- Staging and production Terraform/workflow changes (two new
  Terraform-generated passwords per environment, mirroring
  `discovery_shared_secret`'s existing pattern; two new secrets threaded
  into the existing web/worker task definitions and Kubernetes secrets) are
  implementation-complete but **not deployed** by this task, matching P4.1
  Task 5's own precedent: the live rehearsal (apply Terraform, run
  `deploy-staging.yml`, verify the cutover and a rollback under real
  traffic) is a separate, explicitly tracked next step, since triggering it
  spends real AWS money and needs GitHub environment access an agent should
  not use unilaterally.
- Development's externally-supplied database (not Terraform-managed, unlike
  staging/production's Aurora) needs the maintainer to populate two new,
  currently-empty Secrets Manager placeholders
  (`vinylhound-development/scan-database-url`,
  `.../core-database-url`) with real connection strings for two
  least-privilege roles on that same database before the next
  `deploy-development.yml` run — otherwise migration 021's `GRANT`
  statements fail for lack of the roles they name. This mirrors exactly how
  `database-url` itself is already provisioned there.
- `npm run db:migrate` now runs `packages/database/scripts/migrate.ts`
  (via `tsx`) instead of invoking `node-pg-migrate`'s CLI directly, so that
  role bootstrap (`ensureDatabaseRoles`) always runs immediately before the
  migration itself, for every migration path in the repo — this was a real
  gap found while building this task: the CLI-only invocation had no way to
  create the two roles migration 021's own `GRANT` statements need to
  already exist.
- Two logical services now share nothing but a network hop's absence: no
  code path can open one transaction spanning both schemas, because no
  function holds both a `ScanDatabase` and a `CoreDatabase` inside a shared
  `.transaction()` call anywhere in the codebase (verified by the new
  `schema-boundary.integration.ts` GRANT-boundary test, which asserts each
  role's connection is rejected outright when it tries to touch the other's
  schema). This is the physical guarantee P4.3 ("separate platform delivery
  and state ownership") can build on next, if the roadmap proceeds there;
  this ADR does not decide that.
