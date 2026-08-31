# Catalog source evaluation

Evaluated 2026-08-31 for Milestone 3. This is a capability, licensing, and
integration-shape evaluation; it does not claim that either community catalog
is complete or that a catalog match proves which physical pressing a user owns.

## Decision

Use **MusicBrainz as VinylHound's primary canonical catalog**. Map a MusicBrainz
release group to VinylHound's album concept and a MusicBrainz release to its
release/edition concept. Keep VinylHound UUIDs as internal primary keys and
store MusicBrainz identifiers as namespaced external references.

Do not integrate Discogs as the primary source in this slice. It remains the
best candidate for an optional, user-initiated pressing cross-check later,
especially for matrix/runout variants, but that integration needs its own
terms and attribution design.

## Comparison

| Criterion                 | MusicBrainz                                                                                                                                                                                                                                                                                    | Discogs                                                                                                                                                                                                                                                                                                                 | Result                                                                                        |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Concept model             | Explicit [release group](https://musicbrainz.org/doc/Release_Group) and [release](https://musicbrainz.org/doc/Release) entities closely match VinylHound album/release boundaries.                                                                                                             | Master/release separation and a vinyl-focused catalog also fit, but its API model would require Discogs-specific attribution throughout the product.                                                                                                                                                                    | MusicBrainz                                                                                   |
| Canonical identity        | MBIDs are permanent UUID identifiers; merged identifiers redirect to the surviving entity ([MBID documentation](https://musicbrainz.org/doc/MusicBrainz_Identifier)).                                                                                                                          | Numeric master/release IDs are useful external identifiers but remain provider-specific and API access is revocable.                                                                                                                                                                                                    | MusicBrainz                                                                                   |
| Search and edition fields | The API searches artist/title, barcode, catalog number, label, country, date, format, and release ID; release lookups can include labels, media, and release groups ([search fields](https://musicbrainz.org/doc/MusicBrainz_API/Search), [API](https://musicbrainz.org/doc/MusicBrainz_API)). | Strong vinyl release search and richer community-entered pressing identifiers, including matrix/runout values.                                                                                                                                                                                                          | Discogs for deepest pressing detail; MusicBrainz is sufficient for the first enrichment pass. |
| Licensing and persistence | Core database data is CC0; supplementary data is CC BY-NC-SA. The public web service is free for non-commercial use ([data license](https://musicbrainz.org/doc/About/Data_License)).                                                                                                          | Catalog metadata such as titles, formats, barcodes, and identifiers is CC0, but images, marketplace, and user data are restricted. The API terms also impose freshness, caching, attribution, and commercial-use conditions ([API terms](https://support.discogs.com/hc/en-us/articles/360009334593-API-Terms-of-Use)). | MusicBrainz has the clearer fit for durable canonical metadata.                               |
| Operational limits        | No API key for public reads; a meaningful User-Agent is mandatory and clients must average no more than one request per second ([rate limits](https://musicbrainz.org/doc/MusicBrainz_API/Rate_Limiting)).                                                                                     | Authentication is needed for search in current clients; the API is rate-limited and requires application attribution.                                                                                                                                                                                                   | MusicBrainz for the current personal deployment.                                              |
| Cover art                 | Separate Cover Art Archive integration; artwork rights remain separate from metadata ([CAA API](https://musicbrainz.org/doc/Cover_Art_Archive/API)).                                                                                                                                           | Release images are restricted data under the API terms.                                                                                                                                                                                                                                                                 | Neither source should be treated as a blanket license to persist or republish artwork.        |

## Intended lookup flow

1. Start with the user-reviewed artist/title candidate, never raw AI output as
   a verified fact.
2. Search release groups by artist/title. Present ambiguous groups for review.
3. Browse releases in the selected group and prefer vinyl media.
4. Rank release candidates using only available evidence: barcode first, then
   label plus catalog number, then country/date/format. Missing pressing
   evidence keeps the result at album or release-group confidence.
5. Persist the user's selection and the provider reference. Never auto-merge
   two local releases based only on normalized artist/title or cover artwork.

## Deduplication rules

- A matching MusicBrainz release-group MBID may identify one album concept.
- A matching MusicBrainz release MBID may identify one release edition.
- Barcode or label/catalog-number matches produce candidates, not automatic
  proof, because identifiers can be reused, entered incorrectly, or span
  variants.
- A redirected/merged MBID should resolve to the current canonical entity while
  retaining the originally observed ID in the audit trail.
- Local/manual releases remain valid when no catalog result exists. Enrichment
  must be nullable and reversible.

## Adapter and persistence requirements

These requirements are implemented in Milestone 3 task 2. Catalog search is a
user-triggered review action rather than automatic enrichment; cover-art
fetching remains excluded.

- Put the provider port and MusicBrainz adapter in a catalog package; apps use
  the port rather than calling the provider directly.
- Keep provider traffic server-side. Send a meaningful configured User-Agent,
  serialize requests through a one-request-per-second limiter, retry 503/429
  responses with backoff, and cache normalized metadata.
- Store provider name, entity type, external ID, source URL, fetched timestamp,
  and the normalized fields used for matching. Do not use raw response blobs as
  domain truth.
- Preserve local display values and the user's reviewed correction. Catalog
  enrichment may suggest changes but must not silently overwrite confirmed
  facts.
- Do not fetch Cover Art Archive or Discogs images in the first catalog slice.

## Acceptance test set for the adapter slice

Before enabling automatic suggestions, exercise at least 20 consent-free
metadata cases: common and obscure albums, compilations, same-title albums,
multiple vinyl countries/reissues, barcode matches, catalog-number-only
matches, and a no-result/manual release. Record top-result quality separately
for release-group and exact-release selection.
