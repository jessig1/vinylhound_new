# API and job contracts

This is the intended HTTP surface for the first vertical slice. Runtime schemas belong in `packages/contracts`; generated OpenAPI should eventually be derived from the same source.

The create-scan, request-upload, complete-upload, submit, scan-status,
confirmation, retry, cancel, batch, scan-list, catalog-search, and library
read/update/delete endpoints are implemented.
Identity resolution depends on `AUTH_MODE` (ADR-0013): `development` (the
default) uses a single fixed development identity with no external
provider; `production` verifies a Clerk session and resolves it to the same
internal `users.id` used everywhere else, so user-scoped persistence is
unaffected by which mode is active.

## Conventions

- JSON over HTTPS under `/api/v1`.
- Authenticated user identity comes from the server session, never a request body.
- Mutating endpoints accept an `Idempotency-Key` header and return the original result on safe replay.
- Error bodies use stable machine codes plus a human-readable message and request ID.
- List endpoints use cursor pagination.
- Timestamps are UTC ISO 8601 strings.

## Scan endpoints

| Method | Path                                         | Purpose                                       |
| ------ | -------------------------------------------- | --------------------------------------------- |
| GET    | `/scans`                                     | List the user's scans, newest first           |
| POST   | `/scans`                                     | Create a camera/single/batch scan shell       |
| POST   | `/scans/{scanId}/uploads`                    | Request signed upload instructions            |
| POST   | `/scans/{scanId}/uploads/{imageId}/complete` | Confirm upload and integrity metadata         |
| GET    | `/scans/{scanId}/images/{imageId}/thumbnail` | Get a private, short-lived cover read URL     |
| POST   | `/scans/{scanId}/submit`                     | Validate and enqueue the scan                 |
| GET    | `/scans/{scanId}`                            | Read status, progress, candidates, and errors |
| POST   | `/scans/{scanId}/retry`                      | Create a new attempt for a retryable scan     |
| POST   | `/scans/{scanId}/cancel`                     | Stop an active scan, or dismiss its result    |
| POST   | `/scans/{scanId}/confirm`                    | Confirm/correct and add to the chosen list    |

Photos of several views of one record belong to one scan, not several jobs
(`viewType`, below). Photos of several _different_ records belong to one
**batch** instead: each photo becomes its own independent scan, and the batch
is only a grouping.

`POST /scans` accepts an optional `batchId`; every scan created with the same
`batchId` shares that grouping. `GET /scans` and `GET /scans/{scanId}` both
return the owning `batchId` (`null` for an ungrouped scan) so the client can
link back to batch progress. Batch members use the `batch_upload` ingestion
source, and the server enforces the shared 20-scan batch limit under a batch-row
lock rather than relying on the browser limit.

The `/scan` browser flow is an upload-only capture-session draft: every
selected cover photo creates one independent record draft. Starting the session
creates a batch and adds/submits each draft as an independent `batch_upload`
scan, at most three uploading concurrently, with per-record retry/cancel. The
queue's bookkeeping (batch/scan identity and idempotency keys, never file
bytes) persists to `localStorage` and rehydrates after a refresh; a record
whose image never finished uploading comes back needing its photo reattached.
Selected local files themselves are not durable across a refresh — only the
server-side progress already made is.

Each requested upload declares a `viewType` (`front`, `back`, `spine`, `label`,
`barcode`, `runout`, or `other`; defaults to `front` when omitted, preserving
the original single-image request shape). `GET /scans/{scanId}` returns each
image's `viewType` alongside its filename and MIME type. The worker sends every
completed image to the identifier in one request, each paired with its view
label, so the model can combine cover and edition evidence from the same
physical record instead of treating extra photos as separate scans.

`POST /scans/{scanId}/retry` requires `Idempotency-Key` and no request body.
It is valid only for a `failed` or `unresolved` scan and reuses its
already-uploaded, completed images to start a new attempt through the same
outbox/worker path as the original submission (`202` for the new attempt,
`200` for a scan already `queued`/`processing` from an earlier retry).
`needs_review` is not retryable — a scan with a reviewable result is handled
by confirmation or manual correction, not a new attempt.

`POST /scans/{scanId}/cancel` requires `Idempotency-Key` and no request body.
It is valid from `awaiting_upload`, `queued`, or `processing` (stopping an
active scan) and always returns `200` with `{ "status": "canceled" }`,
including on replay of an already-canceled scan. Canceling before the worker
has dispatched the job skips it for good; canceling while an attempt is
already processing does not abort that in-flight provider call — it finishes
and persists a result, but no further attempt is queued afterward. See
ADR-0006.

The same endpoint also dismisses a reviewable result: `identified`,
`needs_review`, `unresolved`, and `failed` are cancelable too, so a user can
discard a scan they do not want to act on without confirming it. It rejects
with `invalid_state` if the scan already has a confirmation (`scan_confirmations`
row) — a saved result cannot be dismissed after the fact. See ADR-0017.

## Batch endpoints

| Method | Path                 | Purpose                                           |
| ------ | -------------------- | ------------------------------------------------- |
| POST   | `/batches`           | Create an empty batch shell                       |
| GET    | `/batches/{batchId}` | Read every member scan's status and top candidate |

`POST /batches` requires `Idempotency-Key` and an empty JSON body (`{}`). The
returned `batchId` is then passed to `POST /scans` for each photo. A batch has
no status of its own — `GET /batches/{batchId}` always recomputes each
member scan's current state from `scans`/`scan_attempts`, so it can never
drift out of sync with `GET /scans/{scanId}` for the same scan. It also
returns a `cost` summary (token totals and estimated USD) aggregated across
every attempt made by the batch's member scans.

## Quota endpoint

| Method | Path     | Purpose                                           |
| ------ | -------- | ------------------------------------------------- |
| GET    | `/quota` | Advisory daily/active-scan/monthly-spend headroom |

`GET /quota` reports the same three signals `POST /scans/{scanId}/submit` and
`POST /scans/{scanId}/retry` enforce transactionally
(`USER_DAILY_ANALYSIS_LIMIT`, `USER_ACTIVE_SCAN_LIMIT`,
`USER_MONTHLY_SPEND_LIMIT_USD`) as `{ used, limit, remaining }` per dimension,
plus `admissible` and, when `false`, `blockedBy` naming which dimension would
block a new scan right now. This read takes no per-user lock — unlike submit
and retry, which serialize behind a `pg_advisory_xact_lock` so concurrent tabs
see a consistent reservation balance — so it can be stale under concurrency in
both directions and must never be treated as a submission guarantee. The
`/scan` capture session polls it before starting/resuming and after a
`quota_exceeded` failure, to show why capture has paused and let the banner
clear once headroom returns, without retrying the failed request in a loop.

`POST /scans` also runs this same unlocked check before creating a genuinely
new scan (not on idempotent replay) and rejects with `quota_exceeded` if it is
already clearly inadmissible, so a session with no realistic chance of being
admitted fails before the client spends time uploading and normalizing an
image. This is advisory, not authoritative: it can both false-pass (a
concurrent request wins the real check) and, more rarely, false-block; submit
and retry remain the sole enforcement point.

## Usage endpoint

| Method | Path     | Purpose                                              |
| ------ | -------- | ---------------------------------------------------- |
| GET    | `/usage` | Account-wide scan/cost summary over a rolling window |

`GET /usage` reports scan counts by outcome and a token/cost summary
(`attemptCount`, `totalInputTokens`, `totalOutputTokens`, `totalTokens`,
`estimatedCostUsd`, `averageDurationMs`) over the trailing 30 days
(`USAGE_SUMMARY_WINDOW_DAYS`). It aggregates every `scan_attempts` row with
recorded token usage for scans owned by the user and created within the
window; a failed attempt that never reached the provider has no token usage
and is excluded from the cost figures but still counted in `outcomes.failed`.
`estimatedCostUsd` uses the same per-model USD/million-token table as the
private eval harness (`packages/domain`'s `MODEL_PRICING_USD`) and is `null`
when no attempt in the window used a priced model.

## Account endpoints

| Method | Path              | Purpose                                     |
| ------ | ----------------- | ------------------------------------------- |
| GET    | `/account/export` | Export all of the user's own data as JSON   |
| DELETE | `/account`        | Permanently delete the account and its data |

`GET /account/export` (ADR-0014) returns every row the requesting user owns:
account, batches, scans, image metadata (not image bytes), attempts,
confirmations, library items, and library copies, plus each stored image's
`objectKey`. It has no side effects and needs no `Idempotency-Key`. An
exported confirmation whose saved record was since removed carries
`libraryItemId: null` and `list: null` (ADR-0018); the decision itself is
still the user's data and is still exported.

`DELETE /account` (ADR-0014) permanently deletes the account: `users` and
every FK-cascaded row (`scans`, `image_assets`, `scan_attempts`,
`scan_candidates`, `batches`, `library_items`, `library_copies`), plus the
user's `scan_confirmations` rows deleted explicitly first (they carry a
deliberate `restrict` FK to `releases` that a plain cascade cannot satisfy on
its own). Shared catalog rows (`albums`,
`releases`) are never touched. Each deleted image's `original`/`analysis`/
`thumbnail` S3 objects are then deleted best-effort. Like
`DELETE /library/{itemId}`, no `Idempotency-Key` is required — deletion is
naturally idempotent by identity; a repeat call after the account is gone
returns `not_found`.

## Library endpoints

| Method | Path                                                  | Purpose                  |
| ------ | ----------------------------------------------------- | ------------------------ |
| GET    | `/library?list={collection,wishlist}&q=&sort=`        | Read the selected list   |
| GET    | `/library/export?list={collection,wishlist}&q=&sort=` | Download the list as CSV |
| PATCH  | `/library/{itemId}`                                   | Change list or notes     |
| DELETE | `/library/{itemId}`                                   | Remove a list item       |

The list query (with search/sort), export, `PATCH`/`DELETE`, and
server-rendered collection/wishlist pages are implemented. Adding a release
still only happens through the atomic scan-confirmation command
(`POST /scans/{scanId}/confirm`); there is no standalone `POST /library` —
`AddLibraryItemSchema` is a contract for a future direct-add flow, not a
route.

`q` (optional, trimmed, max 200 characters) matches against the displayed
artist or title, case-insensitively; `sort` (optional, default `recent`) is
`recent` (most recently added/updated first, the existing behavior),
`artist`, or `title`. Both parameters are validated together with `list` by
`LibraryQuerySchema`. Matching and sorting operate on the same effective
artist/title the response already returns — which prefers a scan
confirmation's corrected values over the shared album row — rather than the
raw `albums`/`releases` columns, so a corrected identification is searchable
immediately (ADR-0012). Both apply after the existing 100-item fetch, so a
search narrows within that page rather than searching beyond it.

`GET /library/export` accepts the same `list`/`q`/`sort` parameters and
returns `text/csv` with a `content-disposition: attachment` header
(`{list}.csv`) instead of JSON. Columns: `artist`, `title`, `releaseYear`,
`label`, `format`, `country`, `list`, `notes`, `copyCount`. It does not
include per-copy detail or catalog references.

`PATCH /library/{itemId}` accepts `{ list?, notes? }` (at least one field
required) and does not touch copies. Moving a wishlist item to `collection`
creates one blank copy if the item has none yet, matching confirmation's "first
owned copy" rule. Moving a `collection` item to `wishlist` is rejected with
`invalid_state` while it still has any copies, so a copy is never silently
orphaned. Per-copy condition/location/notes/acquisition-date editing is not
part of this endpoint (ADR-0010, ADR-0011).

`DELETE /library/{itemId}` removes the item and cascades its copies. Any
`scan_confirmations` row that pointed at it keeps every audit field while its
`library_item_id` clears itself (ADR-0018, migration 012), so the decision
survives and the originating scan reads as unconfirmed and reviewable again —
the same record can be saved from it a second time. This supersedes ADR-0011's
rejection of items with confirmation history, which in practice made nearly
every real item permanently undeletable.

Collection responses include `copyCount` and `copies`; each copy has optional
media/sleeve condition, storage location, notes, and acquisition date. Wishlist
items always contain zero copies. Every item also carries `coverImage`
(`{ scanId, imageId }` or `null`) identifying the first completed image of the
scan it was confirmed from, which the client exchanges for a short-lived read
URL through `GET /scans/{scanId}/images/{imageId}/thumbnail`.

## Catalog endpoint

| Method | Path                                              | Purpose                            |
| ------ | ------------------------------------------------- | ---------------------------------- |
| GET    | `/catalog/releases?artist={artist}&title={title}` | Search reviewable vinyl candidates |

The server-side MusicBrainz adapter adds `format:vinyl`, sends a meaningful
User-Agent, serializes requests at one per second, retries transient 429/503
responses, and caches normalized results for 24 hours. Results include
release-group/release MBIDs, source/fetch provenance, date, country, labels,
barcode, formats, packaging, status, and provider score. The review screen only
persists a reference after the user selects a result.

## Queue contract

The first job is `scan.analyze.v1`, defined by `AnalyzeScanJobSchema`. Payloads contain IDs, not image bytes or URLs. The worker retrieves authoritative rows and sends request-scoped Base64 image data at execution time; image bytes and data URLs are never persisted or logged.

Job IDs should be deterministic per scan attempt. Redelivery checks the attempt state before spending provider tokens.

`POST /scans/{scanId}/submit` requires `Idempotency-Key` and no request body. It
returns `202` for the first successful submission and `200` for a replay:

```json
{
  "scanId": "00000000-0000-4000-8000-000000000000",
  "status": "queued",
  "attemptNumber": 1,
  "jobId": "scan-00000000-0000-4000-8000-000000000000-attempt-1"
}
```

Submission requires at least one image and requires every registered upload to
be complete. The transaction changes the scan state and writes the outbox row;
the web request does not depend on the configured queue transport being
available.

`GET /scans/{scanId}` is the polling endpoint. It returns the current scan state,
latest delivery attempt, safe failure information, review reasons, token usage,
and ranked candidates. It never returns object keys, image bytes, the OpenAI key,
or the provider's raw response.

Provider deliveries are append-only audit rows. Transient timeout, rate-limit,
and provider-availability failures return the scan to `queued` for queue redelivery.
Refusal, invalid-image, schema, and unknown failures become visible `failed`
states. A succeeded logical attempt is skipped on redelivery before another
provider call is made. If the scan was canceled before the worker picked up
the job, the worker skips analysis entirely and makes no provider call.

`POST /scans/{scanId}/confirm` requires `Idempotency-Key` and accepts the
selected candidate ID (or `null` for a manual identification), reviewed release
fields, `collection` or `wishlist`, and optional notes. It is valid only for an
`identified`, `needs_review`, or `unresolved` scan with a successful attempt.
The selected candidate, when present, must belong to the latest successful
attempt.

Confirmation is atomic: it records the human decision, creates or reuses the
normalized album/release, stores optional namespaced catalog references, and
creates or updates the library item in one transaction. A collection request
also creates one physical copy (even when all copy fields are blank); a wishlist
request creates none. Repeated scans of the same catalog release reuse the
library item but create distinct copies. Adding an owned release converts an
existing wishlist item; requesting a wishlist entry never downgrades an owned
item. `GET /scans/{scanId}` returns the stored confirmation so a refresh or lost
response can recover safely.

## Upload constraints (initial defaults)

- Accept JPEG, PNG, WebP, and non-animated GIF at the public contract, then decode and normalize accepted assets server-side.
- Limit each scan to 12 images and enforce per-file/request limits below provider limits.
- Record a SHA-256 checksum and reject a declared MIME type that disagrees with decoded content.
- Derive an analysis copy and a thumbnail synchronously at upload completion; retain the original according to the configured policy.

Exact product limits should be centralized configuration and returned by the create-scan response so clients do not hard-code them.

Upload completion reads the stored object server-side and verifies its actual byte
length, SHA-256 digest, signed `Content-Type`, binary signature, decoded dimensions,
decoder validity, and frame count. Invalid or animated objects are rejected and
removed from object storage.

Once validated, the same decoded bytes are resized into a bounded analysis
copy (JPEG, long edge capped at 2048px) and a UI thumbnail (JPEG, long edge
capped at 400px), stored alongside the original under sibling object keys
(`.../analysis`, `.../thumbnail`). Scan analysis reads the analysis copy, not
the original, so per-request payload size and OpenAI token cost no longer
scale with the phone camera's native resolution (ADR-0007). The
`CompleteImageUploadResponse` contract is unchanged; `width`/`height`
continue to describe the original as uploaded.

Images completed before migration 009 have no derived-object metadata. Retry
and redelivery fall back to their validated original object so historical scans
remain analyzable; all newly completed images use the bounded analysis copy.
The thumbnail endpoint verifies scan ownership and responds with a 60-second
signed URL. It uses the original only for those historical images and sends
`Cache-Control: private, no-store`; signed object URLs are never persisted.

The web client derives the declared MIME type from the file's magic bytes rather
than the browser's extension-based `File.type`, so a misnamed file uploads under
its actual format instead of failing server validation, and unsupported formats
such as HEIC are rejected before any upload begins. Server-side validation remains
authoritative.
