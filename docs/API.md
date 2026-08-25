# API and job contracts

This is the intended HTTP surface for the first vertical slice. Runtime schemas belong in `packages/contracts`; generated OpenAPI should eventually be derived from the same source.

## Conventions

- JSON over HTTPS under `/api/v1`.
- Authenticated user identity comes from the server session, never a request body.
- Mutating endpoints accept an `Idempotency-Key` header and return the original result on safe replay.
- Error bodies use stable machine codes plus a human-readable message and request ID.
- List endpoints use cursor pagination.
- Timestamps are UTC ISO 8601 strings.

## Scan endpoints

| Method | Path                                         | Purpose                                           |
| ------ | -------------------------------------------- | ------------------------------------------------- |
| POST   | `/scans`                                     | Create a camera/single/batch scan shell           |
| POST   | `/scans/{scanId}/uploads`                    | Request signed upload instructions                |
| POST   | `/scans/{scanId}/uploads/{imageId}/complete` | Confirm upload and integrity metadata             |
| POST   | `/scans/{scanId}/submit`                     | Validate and enqueue the scan                     |
| GET    | `/scans/{scanId}`                            | Read status, progress, candidates, and errors     |
| POST   | `/scans/{scanId}/retry`                      | Create a new attempt for a retryable scan         |
| POST   | `/scans/{scanId}/confirm`                    | Confirm/correct a candidate and resolve a release |

Batch creation returns independent scan IDs; batch progress is a projection of those scans. Photos of several views of one record belong to one scan, not several jobs.

## Library endpoints

| Method | Path                      | Purpose                           |
| ------ | ------------------------- | --------------------------------- |
| GET    | `/library?list=collection | wishlist`                         | Search and page through a list |
| POST   | `/library`                | Add a confirmed release to a list |
| PATCH  | `/library/{itemId}`       | Change list or notes              |
| DELETE | `/library/{itemId}`       | Remove a list item                |

## Queue contract

The first job is `scan.analyze.v1`, defined by `AnalyzeScanJobSchema`. Payloads contain IDs, not image bytes or signed URLs. The worker retrieves authoritative rows and creates a fresh, short-lived read URL at execution time.

Job IDs should be deterministic per scan attempt. Redelivery checks the attempt state before spending provider tokens.

## Upload constraints (initial defaults)

- Accept JPEG, PNG, WebP, and non-animated GIF at the public contract, then decode and normalize accepted assets server-side.
- Limit each scan to 12 images and enforce per-file/request limits below provider limits.
- Record a SHA-256 checksum and reject a declared MIME type that disagrees with decoded content.
- Create thumbnails/previews asynchronously; retain the original according to the configured policy.

Exact product limits should be centralized configuration and returned by the create-scan response so clients do not hard-code them.
