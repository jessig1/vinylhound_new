# ADR-0009: MusicBrainz is the primary canonical catalog

- Status: accepted
- Date: 2026-08-31

## Context

Milestone 3 needs canonical external identifiers, artist/title search,
deduplication support, and edition metadata without weakening VinylHound's rule
that cover recognition does not prove a pressing. The initial candidates were
MusicBrainz and Discogs. Both are community-maintained and can model an album
concept separately from individual releases, but their licensing, operational
limits, and pressing depth differ.

MusicBrainz exposes release-group and release MBIDs, searchable release fields,
and CC0 core metadata through a public API with a required meaningful
User-Agent and a one-request-per-second limit. Discogs has stronger
vinyl-specific pressing coverage, particularly structured identifiers and
runout variants, but its API mixes CC0 catalog fields with restricted images,
marketplace, and user data and imposes additional caching and attribution
terms. The full comparison is in `docs/CATALOG_EVALUATION.md`.

## Decision

MusicBrainz will be the primary catalog provider. A MusicBrainz release group
maps to VinylHound's album concept; a MusicBrainz release maps to a release
edition. Internal UUIDs remain authoritative, with provider/entity/MBID stored
as nullable external references and provenance.

Catalog results remain untrusted candidates until reviewed. Exact MBIDs can
anchor deduplication, while barcode, label/catalog number, country, date, and
format only rank candidates. A cover-only match never establishes a release
MBID. Manual releases remain first-class when no suitable catalog record exists.

The adapter must live behind a catalog port, run server-side, identify itself
with a configured User-Agent, and enforce the provider's one-request-per-second
limit with caching and retry/backoff. Cover art is excluded from the initial
integration.

Discogs is deferred to a separate optional pressing-verification adapter. It
must not be added without a fresh terms review and an explicit design for
attribution, caching, restricted data, and image handling.

## Consequences

- The external model reinforces the existing album/release boundary instead of
  replacing it with a provider-specific schema.
- Canonical IDs improve deduplication, but MBID merges still require redirect
  resolution and preservation of the originally observed identifier.
- The free public API is adequate for personal use but too slow for unbounded
  batch fan-out; catalog lookups need a shared limiter, cache, and asynchronous
  execution when enrichment is attached to scans.
- MusicBrainz may not distinguish every matrix/runout pressing. VinylHound must
  preserve user-entered pressing evidence and may later offer a Discogs
  cross-check rather than manufacturing certainty.
- A future commercial launch must re-check API service terms and supplementary
  data licensing even though MusicBrainz core data is CC0.
