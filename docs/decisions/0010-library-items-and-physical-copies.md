# ADR-0010: Library relationships and physical copies are separate

- Status: accepted
- Date: 2026-08-31

## Context

The original library schema allowed one row per user/release and used its list
to represent collection or wishlist membership. That correctly prevented
duplicate wishlist entries, but it could not represent two owned copies of one
release without duplicating the user's relationship or weakening uniqueness.

## Decision

Keep `library_items` unique by user and release. A collection item owns zero or
more `library_copies`; each owned-record confirmation creates one copy linked to
its originating scan. A wishlist item owns no copies. Converting a wishlisted
release to owned updates the existing library item and creates the first copy.

Copy-specific condition, location, notes, and acquisition date live on the copy.
Release facts and namespaced catalog references remain on the shared release and
catalog-reference records. Existing collection items are backfilled with one
blank copy so migration does not erase their ownership meaning.

## Consequences

- Repeated scans of the same release create distinct physical copies while the
  user/release relationship remains unique.
- Wishlist uniqueness and wishlist-to-owned conversion keep their existing
  transaction semantics.
- Copy deletion or editing will need explicit commands in the next library
  management slice; deleting a library item cascades through its copies.
- A database constraint does not currently assert that copy user/release values
  match the parent library item; repository transactions are authoritative and
  integration tests cover that invariant.
