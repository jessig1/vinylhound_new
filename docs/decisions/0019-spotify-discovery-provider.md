# ADR-0019: Spotify as the discovery provider, MusicBrainz as the catalog provider

- Status: Accepted
- Date: 2026-09-11
- Supersedes: none
- Amends: [ADR-0009](0009-musicbrainz-primary-catalog.md)

## Context

`/discover` shipped in P3.3 Task 1 as a two-field form over MusicBrainz: a user
had to supply both an artist _and_ an album title, and got back vinyl pressings
of that one album. It could not answer "everything by this artist", could not
search by track, and showed no artwork, because MusicBrainz serves metadata and
leaves cover art to the separate Cover Art Archive.

The maintainer asked for the discovery experience from the previous VinylHound
implementation ([frontend](https://github.com/jessig1/vinylhound-frontend),
[backend](https://github.com/jessig1/vinylhound-backend)): one free-text box,
debounced, returning artists, albums and tracks as three sections with
thumbnails, and clicking through artist → discography → album → tracklist. That
implementation ran on Spotify.

Two properties of MusicBrainz make it a poor fit for that specific experience:

1. **Rate limiting.** Clients must average no more than one request per second.
   The adapter enforces this with a serializing limiter, so a debounced
   typeahead fanning out to three entity searches costs 3+ seconds per query.
2. **No artwork, and no artist-first browse shape.** Cover art requires a
   second integration against a different host with its own licensing posture.

Two properties of Spotify make it a poor fit for the inventory:

1. **It has no pressing entity.** A Spotify album is a streaming release. There
   is no catalog number, no country, no format, no packaging, and no release
   status — the exact fields that distinguish one vinyl pressing from another,
   and the fields scan review collects.
2. **It is a licensed commercial API**, not a CC0 dataset, so it is a weaker
   foundation for durable canonical records than ADR-0009 chose MusicBrainz to
   be.

## Decision

Run both, with a hard split by question asked.

**MusicBrainz stays the catalog provider** behind `CatalogProvider`. It answers
"which pressing is this?" and remains the only provider consulted by the scan →
review → confirm path that produces inventory records. ADR-0009 is unchanged in
substance.

**Spotify becomes the discovery provider** behind a new, separate
`DiscoveryProvider` port. It answers "what music exists?" — search, artwork,
artist pages, discographies, tracklists. It is never consulted to establish a
pressing.

The two ports are deliberately not unified. A single `search()` returning a
blended result set would make it possible, and eventually likely, for streaming
browse data to be treated as pressing evidence somewhere downstream. Separate
ports, separate contracts (`catalog.ts` versus `discovery.ts`), and separate
routes (`/catalog/*` versus `/discovery/*`) make that a type error rather than
a judgement call.

### How a Spotify result becomes a saved record

A user can save an album from `/discover` without scanning. That record is
honest about its provenance in three machine-readable ways:

1. **`CatalogReference.releaseId` is null.** The reference schema now carries a
   nullable `releaseId` and refuses a non-null one for Spotify. Null is not
   missing data awaiting backfill; it states that this provider models no
   pressing. MusicBrainz references are still required to carry one.
2. **Release identity falls back to attributes.** `resolveReviewedRelease`
   derives the `releases.identity_key` from a provider reference _only_ when
   that reference names a pressing. A Spotify-sourced record dedupes on
   normalized artist/title/year/label/barcode exactly as a hand-entered record
   does, so two genuinely different pressings of one album stay two releases.
3. **Unavailable fields are saved as null, never guessed.** Catalog number,
   country, format, packaging and release status have no Spotify equivalent and
   are written as null. Only `label` and the UPC/EAN `barcode`, which Spotify
   does supply, carry over.

The UI states the same thing in words on the save control, so the constraint is
visible to the user and not only to the schema.

### Persistence

`catalog_references.external_id` was already `varchar(255)` with a
`(provider, entity_type, external_id)` unique index, so Spotify's 22-character
base-62 IDs need no column change and cannot collide with MBIDs. Migration
`015_spotify_discovery_provider.sql` adds `'spotify'` to the `catalog_provider`
enum. Spotify references are written at `entity_type = 'album'` only.

### Configuration

`SPOTIFY_CLIENT_ID` and `SPOTIFY_CLIENT_SECRET` are optional and validated
together. When unset, `context.discovery` is null, the `/discovery/*` routes
answer `503 discovery_not_configured`, and `/discover` says the feature is not
set up. Scanning, review, confirmation and the library are unaffected — a
deployment without Spotify credentials is a fully working VinylHound. The
credentials are server-side only and never exposed as `NEXT_PUBLIC_*`; the
client-credentials token is minted and cached in the server process.

## Consequences

**Good.** The discovery experience the maintainer asked for is achievable
without fighting a 1 req/s budget, and without a Cover Art Archive integration
or its artwork-licensing questions — Spotify returns image URLs inline.
Scanning keeps the provider whose data model actually distinguishes pressings.
The nullable `releaseId` makes "this identifies an album, not a pressing"
enforceable by schema rather than by convention.

**Costs.** Two providers to operate, two failure modes to explain, and a second
set of API terms. A user who saves from `/discover` gets a thinner record than
one who scans a sleeve — deliberately, but it is still thinner, and the product
has to keep saying why. `DiscoveryProvider` being a separate port means a future
provider swap for discovery is an adapter change, but the discovery contracts
are currently Spotify-shaped (22-character IDs, `album_type`), so a second
discovery provider would need those loosened first.

**Not decided here.** Whether Spotify should also appear as an optional
cross-check on the scan review screen; whether the in-process discovery cache
should move to the Redis already in the stack once more than one `apps/web`
replica runs; and whether saved Spotify-sourced records should later be
upgradeable to a MusicBrainz pressing reference in place.
