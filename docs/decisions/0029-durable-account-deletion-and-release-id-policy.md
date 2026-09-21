# ADR-0029: Account deletion is a durable drain-then-delete workflow; the release_id `restrict` FKs become `set null`

- Status: Accepted
- Date: 2026-09-21
- Supersedes: [ADR-0014](0014-account-export-and-deletion.md)'s deletion mechanism (its export design is unchanged)
- Amends: [ADR-0028](0028-async-scan-confirmation.md) ("Left to Task 6")
- Builds on: [ADR-0027](0027-scan-core-schema-ownership.md), [ADR-0011](0011-direct-library-management.md)

## Context

Roadmap P4.2 Task 6
(`docs/roadmap/p4.2-scans-async-confirmation.md`) asks to "replace the
cross-boundary confirmation/library restrict FK with explicit application
invariants and durable audit references/projections. Record the policy in an
ADR and preserve protected-history behavior unless explicitly changed. Make
account export/deletion a durable, authenticated, retryable workflow; late
events must not recreate deleted account data." ADR-0027 named the exact five
FKs this covers and the exact transaction it targets:
`scan_confirmations.release_id`/`library_item_id`/`copy_id` and
`confirmation_receipts.release_id`/`library_item_id`/`copy_id`, and
`deleteAccount` (`packages/database/src/account-repository.ts`).

ADR-0028 (Task 3) already documented the concrete, reachable bug this task
closes, in its own "Left to Task 6" note: `confirmScan` inserts a `pending`
`scan_confirmations` row and enqueues a `scan.confirmed.v1` event before the
"core" consumer (`processScanConfirmation`) ever runs. If the user's account
is deleted in the window between those two points -- `deleteAccount`
(ADR-0014) deletes `scan_confirmations` directly, then deletes `users`,
cascading `scans`/`batches`/`library_items`/`library_copies` -- the
already-dispatched event still reaches `processScanConfirmation`, which then
tries to insert `library_items`/`library_copies` rows referencing a `userId`
that no longer exists. That insert fails with a real foreign-key violation,
which the existing exponential-backoff retry (and, after Task 4, the
reconciliation sweep) simply repeats forever: a stuck, permanently-failing
job, not a clean, recoverable outcome.

Separately, `scan_confirmations.release_id` and `confirmation_receipts.release_id`
are `restrict` FKs into `releases` (ADR-0011's original protection against
silently orphaning confirmation history). ADR-0027's G10 finding already
flagged that a cross-schema FK "will keep working" under the current
single-database deployment -- "which is exactly the trap" -- since it cannot
survive Task 7's physical schema/role split, where `scan` and `core` become
different roles with no cross-schema `GRANT` and therefore no cross-schema FK
at all. **No code path deletes a `releases` row today** (a repository-wide
search confirms it); the `restrict` FK is defensive, not exercised by any
current flow. This ADR replaces it ahead of Task 7 rather than waiting for
Task 7 to break it by construction.

## Decision

### Part A: `release_id` becomes `set null` on both tables

`scan_confirmations.release_id` and `confirmation_receipts.release_id` change
from `restrict` to `set null` (migration
`020_account_deletion_workflow_and_release_id_policy.sql`). Neither table
gets new runtime guard code, because none is needed:

- **`scan_confirmations`**: a `completed` row's `release_id` still cannot
  actually go null in practice. `scan_confirmations_status_consistency_check`
  (migration 019) already requires `release_id IS NOT NULL` whenever
  `status = 'completed'`, and that check applies to the `UPDATE` Postgres
  performs for an `ON DELETE SET NULL` referential action exactly as it does
  to any other update. So a `DELETE FROM releases` referenced by a completed
  confirmation still fails -- just via that check constraint instead of the
  old `restrict` FK, with the identical practical effect. A `pending` row
  already has `release_id IS NULL` (nothing to protect yet). **Protected-history
  behavior for a completed confirmation is unchanged**, satisfying the
  roadmap's "preserve protected-history behavior unless explicitly changed."
  This was verified directly, not assumed: `schema.integration.ts`'s new
  "still protects a completed confirmation's release from deletion" test
  deletes a release referenced by a completed confirmation and asserts the
  rejection carries a `23514` (check-violation) error code, not `23503`
  (foreign-key-violation).
- **`confirmation_receipts`**: this row was already documented (ADR-0028) as
  "a dedupe/audit record, not a protected reference" for its sibling
  `library_item_id`/`copy_id` columns, both already `set null`. `release_id`
  now matches: nulled, not blocking, with `payload` (already stored at insert
  time) keeping the resolved release id for history regardless. The column
  becomes nullable (`ALTER COLUMN release_id DROP NOT NULL`) so the
  referential action has somewhere to write. Verified directly: the new
  "nulls confirmation_receipts.release_id on release deletion" test
  constructs a release referenced only by a `confirmation_receipts` row (with
  every other referencing row removed) and confirms the delete succeeds,
  `release_id` becomes null, and `payload.releaseId` still names the original
  release.

**The application invariant that replaces the removed cross-schema FK is
ownership discipline, not new code**: ADR-0027 already assigns `releases` to
`core`, and no `core`-side code deletes a release. This ADR is the record
that if such code is ever written, it must preserve confirmation/receipt
audit rows via this same null-and-preserve-payload pattern rather than
reintroducing a cross-schema `restrict` dependency that cannot survive Task 7. Writing a guard function with no caller today would be speculative code
for a path that does not exist; the discipline is documented here instead,
where the next implementer of release deletion will find it.

### Part B: account deletion becomes a durable, drain-then-delete workflow

`users` gains a nullable `deletion_requested_at` column. `deleteAccount`
(`packages/database/src/account-repository.ts`) changes from "always one
synchronous hard-delete transaction" to:

1. Row-lock `users` (`for("update")`, unchanged). Not found -> `not_found`
   (unchanged).
2. If `deletionRequestedAt` is not already set, set it now, in the same
   transaction. This is the durable, authenticated acceptance of the
   request -- authentication is unchanged, still `requireUserId` (Clerk) on
   `DELETE /api/v1/account` (ADR-0013).
3. Count the user's `pending` `scan_confirmations` rows.
   - **Zero**: hard-delete immediately, in the same transaction --
     byte-for-byte the same cascade ADR-0014 specified (delete
     `scan_confirmations` directly, then `users`, letting every other
     user-owned table cascade). This is the common case and is behaviorally
     identical to today for every existing caller and test.
   - **One or more**: return `status: "pending"` without deleting anything.
     The account is durably marked but the row still exists, so an
     already-dispatched `scan.confirmed.v1` event can still be processed by
     `processScanConfirmation` against a `users.id` that is still valid --
     the exact race this ADR closes.

Once `deletionRequestedAt` is set, `confirmScan` refuses to start any new
confirmation for that account (`account_deleting`, a new
`DatabaseCommandErrorCode`, mapping to `409` like every other
non-`not_found`/`quota_exceeded`/`invalid_cursor` command error). This
prevents the inverse race: a confirmation created after `deleteAccount`
observed zero pending rows and began proceeding toward a hard delete must not
be allowed to start and immediately become another in-flight event racing
that delete. Both checks lock the same `users` row --
`deleteAccount` with `for("update")` (unchanged), `confirmScan`'s new check
with `for("share")` (sufficient for mutual exclusion against a `for("update")`
locker, while still letting concurrent `confirmScan` calls for the same user
proceed against each other) -- so the two transactions serialize on that row
and one always observes the other's committed result, closing both directions
of the race with the same row-lock discipline this codebase already uses
everywhere (`confirmScan`'s own scan-row lock, `deleteAccount`'s original
users-row lock).

A background sweep (`apps/worker/src/index.ts`,
`ACCOUNT_DELETION_POLL_INTERVAL_MS`/`_BATCH_SIZE`, defaults 60s/50) finds
accounts with `deletionRequestedAt` set and zero remaining `pending`
`scan_confirmations` (`listAccountsReadyForDeletion`) and finalizes each
(`finalizeAccountDeletion`) -- the same hard-delete transaction body, shared
with `deleteAccount`'s own immediate path, plus the existing best-effort S3
object cleanup (ADR-0014, unchanged). This mirrors Task 4's
`reconcileScanConfirmation` sweep exactly: idempotent, safe to call any
number of times, off durable state rather than reaching into the queue.
**Retryability** falls out of the same idempotence: a client that retries
`DELETE /api/v1/account` after a dropped response re-enters `deleteAccount`,
which re-checks readiness and either finalizes immediately (if now drained)
or reaffirms the same `pending` state -- never a duplicate side effect, never
an error against an account already correctly mid-workflow.

**What actually closes the ADR-0028 gap.** Before this change, the race was
between two unordered events (account deletion, confirmation processing)
with no coordination. After this change, hard deletion is provably
impossible while a `pending` confirmation exists for that user, because (a)
the hard-delete path only runs once the pending count is verified zero under
a row lock, and (b) no new `pending` row can be created for an account
already marked for deletion. `processScanConfirmation` can therefore never
observe a `userId` that stopped existing between hop 1 and hop 2 -- the
foreign-key violation ADR-0028 documented is no longer reachable, not merely
retried more gracefully. Verified directly:
`schema.integration.ts`'s "defers a whole-account delete while a confirmation
is still pending" test drives a real `pending` confirmation through both
remaining hops (`processScanConfirmation`, `applyConfirmationCompletion`)
_after_ `deleteAccount` has already been called and returned `"pending"`,
and asserts both succeed against a `users` row this test proves is still
present at that point.

**Bounded by the existing reconciliation mechanism, not a new one.** A
`pending` confirmation that never settles (a dead-lettered job with no
reconciliation ever running) would also hold up finalization indefinitely.
This is an accepted interaction with Task 4's existing mechanism, not a new
gap: the same confirmation would already be stuck and user-visible on the
scan page regardless of any deletion request, and Task 4's sweep (5-minute
staleness) and the UI's own 20-second manual retry already exist to drive it
to completion. This task does not add a new terminal "failed" state for a
confirmation (ADR-0028 already declined to add one for Task 4) or a deletion
timeout; reopening that decision is out of scope here.

## Consequences

- `docs/ARCHITECTURE.md`'s "Scan and core services" section is updated to
  describe the drain-then-delete workflow in place of the old
  always-synchronous description.
- `DeleteAccountResponseSchema` gains a required `status: "deleted" | "pending"`
  field. `DELETE /api/v1/account` still returns `200` in both cases; the
  account-settings UI does not need to branch on it today (either way, the
  request has been durably accepted and the client signs out), but the field
  is there for a future UI that wants to show "finishing up" rather than
  treating both outcomes identically.
- `packages/config`'s `QueueWorkerConfigSchema` gains
  `ACCOUNT_DELETION_POLL_INTERVAL_MS`/`ACCOUNT_DELETION_BATCH_SIZE`, worker-only,
  mirroring the existing confirmation-reconciliation knobs' shape.
- This is deliberately scoped to the two things the roadmap task names: the
  `release_id` FK policy and the account-deletion race. It does not perform
  Task 7's physical schema/role/process cutover, and it does not touch
  `library_item_id`/`copy_id`'s existing `set null` policy on either table
  (already correct since ADR-0028).
- `apps/worker/src/e2e-worker.ts` deliberately does not get the account-deletion
  sweep loop, matching this file's existing precedent of omitting worker
  loops the browser e2e suite does not exercise (it already omits the
  abandoned-upload cleanup loop for the same reason); no e2e spec exercises
  account deletion today.
