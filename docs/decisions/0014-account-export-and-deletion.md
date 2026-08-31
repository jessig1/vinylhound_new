# ADR-0014: Account export is metadata-only JSON; account deletion is an ordered hard delete

- Status: accepted
- Date: 2026-08-31

## Context

Milestone 4 requires account deletion/export and a privacy/retention policy
before public rollout (`docs/ROADMAP.md`), following production
authentication (ADR-0013). `docs/SECURITY.md` already flags this as an
explicit gap: "add ... account export/deletion" before multi-user/public
deployment, and asks for retention periods to be defined per data category.

Every user-owned table cascades from `users.id` on delete
(`docs/ARCHITECTURE.md`'s authentication note), with one deliberate
exception: `scan_confirmations.library_item_id` and
`scan_confirmations.release_id` are `restrict` FKs (ADR-0011), added
specifically to stop a single library item's `DELETE` from silently
orphaning its confirmation audit trail. That protection becomes an obstacle
for whole-account deletion: a plain cascading delete of a `users` row would
attempt to cascade into both `scans` (→ `scan_confirmations` via `scan_id`,
`cascade`) and `library_items` (blocked by the `restrict` FK from any
`scan_confirmations` row still referencing it) in the same operation, and
Postgres does not guarantee the ordering needed for that to succeed —
in practice this fails with a foreign key violation.

`albums` and `releases` are shared catalog data, not user-owned: multiple
users' library items can reference the same release. Account deletion must
never delete these rows.

No S3 object cleanup exists today for any deleted scan or image
(`docs/HANDOFF.md`'s known gaps) — an account delete that only removed
database rows would leave every original/analysis/thumbnail object
orphaned in object storage indefinitely, which does not satisfy "delete my
account" under any reasonable privacy reading.

Two questions needed resolving: what an account delete actually does to
`scan_confirmations`' protected rows and to S3 objects, and what an account
export contains.

## Decision

**Export.** `GET /account/export` returns a single JSON document containing
every row the requesting user owns: `users` (id, `createdAt` only — no
`clerk_user_id`, since that is an internal linkage detail, not the user's
data), `scans`, `image_assets` (metadata: filename, view type, mime type,
size, dimensions, checksums, object keys — not image bytes), `scan_attempts`,
`scan_candidates`, `scan_confirmations`, `library_items`, `library_copies`,
and `batches`. No original image bytes are included: bundling and streaming
binary content server-side is materially more complex (zipping, longer
requests, larger responses) for a feature whose primary purpose is
structural transparency and portability, not a photo backup — and the
existing `GET /library/export` CSV establishes the same "metadata, not
binary content" precedent. Each user-owned image's stored `objectKey` is
included so a user (or a future feature) can still request the underlying
object directly if needed. Export is read-only and has no side effects, so
it does not need idempotency-key handling like the mutating endpoints.

**Deletion.** `DELETE /account` performs an ordered hard delete in one
transaction:

1. Row-lock the `users` row (`for("update")`, matching every other
   multi-statement command in this codebase — `confirmScan`,
   `updateLibraryItem`, `deleteLibraryItem`).
2. Collect every `image_assets.object_key` for the user's scans (a `select`
   joined through `scans`), for step 4.
3. Delete every `scan_confirmations` row for the user directly (not via
   cascade), which is what actually satisfies the `restrict` FKs to
   `library_items`/`releases` before anything else in the transaction tries
   to remove a `library_items` row.
4. Delete the `users` row. Every other user-owned table (`scans`,
   `image_assets` via `scans`, `scan_attempts`/`scan_candidates` via
   `scans`, `batches`, `library_items`, `library_copies`) cascades
   automatically from existing `onDelete: "cascade"` FKs. `albums` and
   `releases` are never touched — they have no FK to `users` at all, by
   design, since they are shared catalog data.
5. After the transaction commits, delete each collected S3 object
   (original, analysis, thumbnail — all three exist per `deriveImageObjectKey`,
   ADR-0007) via `ObjectStorage.deleteObject`, best-effort: an individual
   object delete failure is logged, not retried inline and not allowed to
   undo the already-committed database deletion, since a user's data being
   gone from the app but one S3 object lingering is a smaller, recoverable
   problem than a half-deleted account stuck by a storage hiccup. This
   mirrors the existing best-effort posture the codebase already accepts
   elsewhere (ADR-0006's cancellation tradeoff).

Object deletion happens **after** the commit, not inside the transaction,
because `ObjectStorage.deleteObject` is a network call to S3/MinIO and the
existing codebase pattern (`packages/storage`) never holds a database
transaction open across a provider call.

Deletion requires explicit confirmation at the UI level (a maintainer-authored
type-to-confirm step on `/account`, not a bare button) given its
irreversibility, but the API itself performs the delete immediately on a
valid authenticated `DELETE /account` call with no request body — following
`DELETE /library/{itemId}`'s existing precedent (ADR-0011) of not requiring
an `Idempotency-Key` for a delete-by-identity operation, since the delete is
already naturally idempotent: a second call after the account is gone
returns `not_found` rather than duplicating any side effect.

**Retention.** `docs/SECURITY.md`'s "Retention and deletion" section is
updated with concrete periods now that deletion exists to enforce them:
account data (all of the above) is retained until the user deletes their
account or requests deletion, with no automatic time-based expiry in this
slice — VinylHound is a personal collection record, not an ephemeral
service, so indefinite retention while the account exists is the expected
behavior, not a gap. What changes is that deletion is now a real,
user-triggered mechanism rather than an undefined future promise.

## Consequences

- `scan_confirmations` deletion during account deletion is a deliberate,
  narrow exception to ADR-0011's `restrict` protection, not a reversal of
  it: the `restrict` FK still does its job for every other code path
  (single library item delete, any future per-copy delete), and only this
  one whole-account transaction is allowed to remove confirmation rows
  directly.
- Export omits image bytes; a user wanting their original photos back needs
  a future feature (e.g., a signed-URL-per-image endpoint) that this ADR
  does not implement. The `objectKey` values are included in the export
  specifically so that gap is addressable later without another schema
  change.
- S3 object deletion on account delete is best-effort and unretried in this
  slice; a failed object delete leaves an orphaned object with no
  automatic cleanup path, same as every other known S3-orphaning gap in
  this codebase today (ADR-0007's consequences). A future backup/lifecycle
  policy (Milestone 4's "managed infrastructure" item) is the natural place
  to add a periodic sweep for orphaned objects, rather than building retry
  logic into the request path now.
- No time-based automatic data expiry exists or is planned by this slice;
  retention is "until the user deletes the account." A future policy change
  (e.g., deleting stale `unresolved`/`failed` scans automatically) is a
  separate decision this ADR does not make.
- `DELETE /account` is irreversible and destroys real data, so unlike this
  codebase's other mutating endpoints it deliberately does not attempt to
  make retries safe against a mid-flight partial state beyond "the
  transaction either fully commits or fully rolls back" — there is no
  meaningful partial-success semantics to preserve for a full account wipe.
