# API and job contracts

This is the intended HTTP surface for the first vertical slice. Runtime schemas belong in `packages/contracts`; generated OpenAPI should eventually be derived from the same source.

The create-scan, request-upload, complete-upload, submit, scan-status,
confirmation, retry, cancel, batch, and scan-list endpoints are implemented.
They currently use the configured development identity; production
authentication will replace identity issuance without changing user-scoped
persistence.

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
| POST   | `/scans/{scanId}/submit`                     | Validate and enqueue the scan                 |
| GET    | `/scans/{scanId}`                            | Read status, progress, candidates, and errors |
| POST   | `/scans/{scanId}/retry`                      | Create a new attempt for a retryable scan     |
| POST   | `/scans/{scanId}/cancel`                     | Stop a scan that has not yet completed        |
| POST   | `/scans/{scanId}/confirm`                    | Confirm/correct and add to the chosen list    |

Photos of several views of one record belong to one scan, not several jobs
(`viewType`, below). Photos of several _different_ records belong to one
**batch** instead: each photo becomes its own independent scan, and the batch
is only a grouping.

`POST /scans` accepts an optional `batchId`; every scan created with the same
`batchId` shares that grouping. `GET /scans` and `GET /scans/{scanId}` both
return the owning `batchId` (`null` for an ungrouped scan) so the client can
link back to batch progress.

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
It is valid from `awaiting_upload`, `queued`, or `processing` and always
returns `200` with `{ "status": "canceled" }`, including on replay of an
already-canceled scan. Canceling before the worker has dispatched the job
skips it for good; canceling while an attempt is already processing does not
abort that in-flight provider call — it finishes and persists a result, but
no further attempt is queued afterward. See ADR-0006.

## Batch endpoints

| Method | Path                 | Purpose                                           |
| ------ | -------------------- | ------------------------------------------------- |
| POST   | `/batches`           | Create an empty batch shell                       |
| GET    | `/batches/{batchId}` | Read every member scan's status and top candidate |

`POST /batches` requires `Idempotency-Key` and an empty JSON body (`{}`). The
returned `batchId` is then passed to `POST /scans` for each photo. A batch has
no status of its own — `GET /batches/{batchId}` always recomputes each
member scan's current state from `scans`/`scan_attempts`, so it can never
drift out of sync with `GET /scans/{scanId}` for the same scan.

## Library endpoints

| Method | Path                                  | Purpose                           |
| ------ | ------------------------------------- | --------------------------------- |
| GET    | `/library?list={collection,wishlist}` | Read the selected list            |
| POST   | `/library`                            | Add a confirmed release to a list |
| PATCH  | `/library/{itemId}`                   | Change list or notes              |
| DELETE | `/library/{itemId}`                   | Remove a list item                |

The list query and server-rendered collection/wishlist pages are implemented for
the first vertical slice. General library write endpoints remain planned;
confirmation creates or converts an item through the atomic scan-confirmation
command.

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
the web request does not depend on Redis being available.

`GET /scans/{scanId}` is the polling endpoint. It returns the current scan state,
latest delivery attempt, safe failure information, review reasons, token usage,
and ranked candidates. It never returns object keys, image bytes, the OpenAI key,
or the provider's raw response.

Provider deliveries are append-only audit rows. Transient timeout, rate-limit,
and provider-availability failures return the scan to `queued` for BullMQ retry.
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
normalized album/release, and creates or updates the library item in one
transaction. Adding an owned release converts an existing wishlist item;
requesting a wishlist entry never downgrades an owned item. `GET /scans/{scanId}`
returns the stored confirmation so a refresh or lost response can recover safely.

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

The web client derives the declared MIME type from the file's magic bytes rather
than the browser's extension-based `File.type`, so a misnamed file uploads under
its actual format instead of failing server validation, and unsupported formats
such as HEIC are rejected before any upload begins. Server-side validation remains
authoritative.
