# ADR-0021: Favorites are an attribute of a saved record; playlists order saved records

- Status: Accepted
- Date: 2026-09-12
- Supersedes: none
- Builds on: [ADR-0010](0010-library-items-and-physical-copies.md),
  [ADR-0018](0018-removable-library-items.md),
  [ADR-0019](0019-spotify-discovery-provider.md)

## Context

Roadmap P3.3 Task 2 asks for release favorites and user-owned ordered
playlists of saved release references, with favorite/unfavorite and playlist
create/rename/reorder/remove/delete, contracts and domain rules defined before
persistence or UI. Two modelling questions decide most of the shape:

1. **What does a favorite attach to?** A release row (shared, catalog-level),
   a new per-user table keyed by release, or the existing per-user
   `library_items` row that already represents "this user's relationship to
   this release" (ADR-0010).
2. **What does a playlist entry reference?** The same three options, plus a
   fourth: a catalog or discovery result that was never saved.

Since ADR-0019 the discovery provider is Spotify, which makes "playlist" read
as a streaming feature. The roadmap is explicit that playlists organize music
and that playback is out of scope; the model has to make that hard to drift
from rather than merely say it.

## Decision

### A favorite is an attribute of the saved relationship

`library_items` gains a nullable `favorited_at`. There is no third list and no
separate favorites table. A record in either the collection or the wishlist
can be a favorite; the favorites view (`GET /library/favorites`, `/favorites`)
reads the same rows the two list pages read, filtered to those marked.

Consequences that follow from this rather than needing separate code: nothing
can be favorited that is not saved; removing a saved record removes the
favorite with it; account export already selects `library_items` by user and
account deletion already cascades through it. Favorite/unfavorite is
`PATCH /library/{itemId}` with `{ favorite: boolean }` and is idempotent by
identity — re-favoriting keeps the original `favoritedAt` rather than resetting
it, and un-favoriting an unfavorited record is a no-op
(`resolveFavoritedAt` in `@vinylhound/domain`).

### A playlist is an ordered list of the user's own library items

`playlists` (user-owned, `name` unique per user after normalization) and
`playlist_entries` (`playlist_id`, `library_item_id`, `position`). Every entry
references a `library_items` row belonging to the same user — a saved release,
never a bare `releases` row and never a catalog or discovery result. The
contract admits only `{ libraryItemId }` when adding, so putting an unsaved
album in a playlist is a type error, not a policy. A playlist therefore
cannot become a queue of streaming albums by accident: it can only hold what
the user has already chosen to keep, and it carries no playback affordance.

Rules, each enforced in `@vinylhound/domain` or by a constraint:

- **One entry per saved release per playlist** — unique
  `(playlist_id, library_item_id)`. Adding again converges (`200`) instead of
  duplicating.
- **Names unique per user** after `normalizePlaylistName` (NFKC, case fold,
  whitespace collapse; punctuation kept). Creating an existing name returns
  the existing playlist (`200`, not `201`); renaming onto another playlist's
  name is `409 conflict`.
- **Ordering is by `position`**, unique per playlist and ascending, but not
  guaranteed contiguous: when a saved record is removed, its entries are
  removed by cascade and the remaining positions keep their gaps. An append
  goes after the current maximum; a reorder renumbers from 1.
- **A reorder must name every current entry exactly once**
  (`resolvePlaylistOrder`). A partial or stale order — one that omits an entry
  or names one the playlist no longer holds — is rejected with `409` and never
  partially applied, so two devices editing one playlist cannot silently drop
  each other's changes. The client reloads and retries.
- **Ownership is by absence.** Another user's playlist, entry, or saved
  record reads as `not_found` from every operation; nothing distinguishes
  "not yours" from "does not exist".
- **Limits**: 100 playlists per user, 500 entries per playlist, names 1–100
  characters. Exceeding one is `409 playlist_limit` /
  `409 playlist_entry_limit`; converging on an existing name or entry is still
  allowed at the limit.

### Idempotency by identity, not by key

`POST /playlists` and `POST /playlists/{id}/entries` follow `POST /library`
(ADR-0019) rather than the scan endpoints: no `Idempotency-Key`, because the
natural key (normalized name; playlist + saved record) already makes a replay
converge. Every mutation of one playlist takes a `for update` row lock on it
first, and creates take a per-user advisory lock so the playlist-count check
cannot be raced past.

### Persistence detail worth recording

`(playlist_id, position)` is unique and PostgreSQL checks that constraint per
row, so renumbering in place would collide mid-statement. A reorder therefore
lifts every position above the current maximum in one statement, then assigns
the final `1..n` in a second, inside the locked transaction. The alternative —
a `DEFERRABLE INITIALLY DEFERRED` constraint — would have required expressing
it outside the Drizzle schema declaration, which is the source of truth the
integration tests read.

## Consequences

**Good.** Favorites cost one column and inherit every existing guarantee.
Playlists can only organize saved music, by construction. Export and deletion
cover both without new ordering rules (`playlists` cascades from `users`;
`playlist_entries` cascades from both `playlists` and `library_items`). The
favorites page is the library page with a filter, so search and sort behave
identically.

**Costs.** A favorite cannot outlive its record — a user who removes a record
and re-saves it later starts unfavorited, which is arguably right but is a
choice. A playlist cannot reference music the user has not saved, so "save
this, then add it to a playlist" is two steps from `/discover`. Position gaps
mean the `position` field in responses is an ordering key, not a 1-based
index; the UI numbers entries itself.

**Not decided here.** Whether favorites should also be a sort or filter on the
list pages themselves; whether the discover album page should offer "save and
add to playlist" in one action; and whether playlists should ever be
shareable (the product currently excludes public profiles and shared
collections).
