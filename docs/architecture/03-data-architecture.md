# Data architecture

**Status: Current, with proposed extensions called out separately**

PostgreSQL is VinylHound's system of record. It preserves three distinct ideas:
an album as an artistic work, a release as a published edition, and a user's
relationship to that release. Scan evidence and AI output remain auditable and
separate from confirmed library data.

## Current entity relationships

```mermaid
erDiagram
  USERS ||--o{ BATCHES : owns
  USERS ||--o{ SCANS : owns
  BATCHES o|--o{ SCANS : groups
  SCANS ||--o{ IMAGE_ASSETS : contains
  SCANS ||--o{ OUTBOX_MESSAGES : schedules
  SCANS ||--o{ SCAN_ATTEMPTS : records
  SCAN_ATTEMPTS ||--o{ SCAN_CANDIDATES : returns
  SCANS ||--o| SCAN_CONFIRMATIONS : confirms
  USERS ||--o{ LIBRARY_ITEMS : owns
  USERS ||--o{ SCAN_CONFIRMATIONS : makes
  ALBUMS ||--o{ RELEASES : has
  RELEASES ||--o{ LIBRARY_ITEMS : appears_in
  ALBUMS ||--o{ CATALOG_REFERENCES : identified_by
  RELEASES ||--o{ CATALOG_REFERENCES : identified_by
  LIBRARY_ITEMS ||--o{ LIBRARY_COPIES : owns
  USERS ||--o{ LIBRARY_COPIES : owns
  RELEASES ||--o{ LIBRARY_COPIES : describes
  RELEASES ||--o{ SCAN_CONFIRMATIONS : selected_as
  LIBRARY_ITEMS ||--o{ SCAN_CONFIRMATIONS : created_or_reused_by
  LIBRARY_COPIES o|--o| SCAN_CONFIRMATIONS : may_be_created_by
  SCAN_CANDIDATES o|--o| SCAN_CONFIRMATIONS : may_be_selected

  USERS {
    uuid id PK
    timestamptz created_at
  }
  BATCHES {
    uuid id PK
    uuid user_id FK
    text idempotency_key
  }
  SCANS {
    uuid id PK
    uuid user_id FK
    uuid batch_id FK
    enum source
    enum status
    text idempotency_key
  }
  IMAGE_ASSETS {
    uuid id PK
    uuid scan_id FK
    text object_key
    enum view_type
    text checksum_sha256
    bigint original_size_bytes
    bigint analysis_size_bytes
    bigint thumbnail_size_bytes
  }
  OUTBOX_MESSAGES {
    uuid id PK
    uuid aggregate_id FK
    text topic
    int attempt_number
    text idempotency_key
    timestamptz published_at
  }
  SCAN_ATTEMPTS {
    uuid id PK
    uuid scan_id FK
    int attempt_number
    int delivery_attempt
    enum status
    text model
    text prompt_version
    jsonb observations
    jsonb needs_review_reasons
  }
  SCAN_CANDIDATES {
    uuid id PK
    uuid scan_attempt_id FK
    int rank
    text artist
    text title
    real confidence
    jsonb evidence
    jsonb warnings
  }
  ALBUMS {
    uuid id PK
    text artist
    text title
    text normalized_artist
    text normalized_title
  }
  RELEASES {
    uuid id PK
    uuid album_id FK
    text identity_key
    int release_year
    text label
    text catalog_number
    text barcode
    text release_date
    text country
    text format
  }
  LIBRARY_ITEMS {
    uuid id PK
    uuid user_id FK
    uuid release_id FK
    enum list
    uuid confirmed_from_scan_id FK
  }
  LIBRARY_COPIES {
    uuid id PK
    uuid user_id FK
    uuid library_item_id FK
    uuid release_id FK
    uuid confirmed_from_scan_id FK
    enum media_condition
    enum sleeve_condition
    text location
    date acquired_at
  }
  CATALOG_REFERENCES {
    uuid id PK
    enum provider
    enum entity_type
    text external_id
    uuid album_id FK
    uuid release_id FK
    text source_url
    timestamptz fetched_at
  }
  SCAN_CONFIRMATIONS {
    uuid scan_id PK
    uuid user_id FK
    uuid selected_candidate_id FK
    uuid release_id FK
    uuid library_item_id FK
    uuid copy_id FK
    jsonb reviewed_release
    text idempotency_key
  }
```

## Important invariants

| Invariant | Enforcement |
| --- | --- |
| Every scan and library row is owned by one internal user | User foreign keys plus user-scoped repository queries |
| A scan cannot queue before all registered images complete validation | Submission command and database state transition |
| Queue delivery cannot silently diverge from accepted scan state | Scan and outbox message commit in one PostgreSQL transaction |
| Provider retries remain auditable | Logical attempt and delivery attempt are stored separately |
| AI candidates never become library data implicitly | One explicit, idempotent scan-confirmation transaction |
| One user cannot have duplicate wishlist/collection rows for one release | Unique `(user_id, release_id)` library constraint |
| One collection relationship may represent several owned records | A collection item owns separate `library_copies`; each owned confirmation creates a copy |
| A wishlist has no physical copy | Wishlist confirmation creates no copy; wishlist-to-owned conversion updates the item and creates the first copy atomically |
| External identifiers enrich but do not replace internal identity | Namespaced MusicBrainz catalog references point to internal albums/releases and retain source/fetch provenance |
| Display text is not destroyed by matching normalization | Original artist/title and separate normalized keys are retained |

## Storage model

Each completed image has three private objects under an opaque,
user-and-scan-scoped key prefix:

- `original` — retained source upload, subject to a future retention policy;
- `analysis` — bounded 2048px JPEG used for provider requests;
- `thumbnail` — bounded 400px JPEG for future UI display.

The database stores object keys and integrity metadata, not public URLs. Current
deletion cascades database rows but does not yet delete corresponding objects;
the production design must close that lifecycle gap.

## Current catalog enrichment

MusicBrainz is the accepted primary canonical catalog. A release-group MBID may
identify an album concept and a release MBID may identify an edition, but the
lookup is user-triggered and its result remains reviewable. Internal UUIDs and
confirmed display values remain authoritative. `catalog_references` stores the
provider, entity type, external ID, source URL, and fetch time; it does not store
cover art or raw provider payloads.

`library_items` represents a user's collection/wishlist relationship to one
release. `library_copies` represents physical owned records beneath a collection
item, allowing repeated confirmations of the same release to create distinct
copies without duplicating the relationship.

## Proposed post-release scan-recognition catalog

The shared recognition catalog discussed in the
[evolution plan](05-evolution-plan.md) is intentionally not drawn into the
current ERD. A later migration may add:

| Proposed concept | Purpose | Privacy / quality constraint |
| --- | --- | --- |
| `image_fingerprints` | Exact and perceptual fingerprints of normalized covers | Store derived fingerprints, not cross-user access to original images |
| `recognition_matches` | Link a fingerprint to an internally confirmed album/release candidate | Require provenance, confidence, version, and reviewer state |
| `classification_results` | Record album-likelihood gate outcome and model version | Use a conservative rejection threshold and preserve an override path |
| `match_feedback` | Capture confirmations and corrections without overwriting history | Prevent one user's mistaken confirmation from poisoning global matches |

This extension should favor artist/title identification first. Pressing-level
facts remain nullable and require appropriate evidence or a catalog lookup.
