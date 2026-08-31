# Security and privacy

## Data classification

Album photos are user content. They may unintentionally include faces, addresses, receipts, reflections, geolocation EXIF, or other private material. API keys, session tokens, signed URLs, and storage credentials are secrets. Collection and wishlist data are private by default.

## Baseline controls

- Keep all provider and storage credentials on trusted server/worker processes.
- Use short-lived, single-object signed URLs; authorize before every creation/read.
- Generate object keys server-side and scope them by user and scan.
- Validate size, MIME declaration, decoded file signature, dimensions, and animation before processing.
- Strip EXIF from derived images. Define whether originals retain EXIF and communicate that policy.
- Encrypt traffic and managed storage; back up PostgreSQL and test restoration.
- Apply CSRF protection/session hardening, rate limits, upload quotas, and per-user job concurrency.
- Hash stable user identifiers before using any provider safety identifier.
- Redact credentials, signed query strings, and user content from logs and error trackers.
- Set provider spend/rate limits and alert on unusual scan volume.

## AI-specific threats

- Prompt injection: text printed on a cover is untrusted data. The prompt explicitly says not to follow it.
- Hallucinated metadata: strict schemas ensure shape, not truth. Require evidence, use review policy, and validate against a catalog when edition precision matters.
- Denial of wallet: enforce file, batch, user, and concurrency limits before enqueueing provider work.
- Data leakage: do not place one user's images/results in another user's prompt, cache key, URL, or log context.

## Retention and deletion

Account data (scans, images, attempts, confirmations, library items/copies)
is retained until the user deletes their account; there is no automatic
time-based expiry in this slice (ADR-0014) — VinylHound is a personal
collection record, not an ephemeral service, so indefinite retention while
an account exists is the expected behavior. `DELETE /account` (ADR-0014)
performs an ordered hard delete of every user-owned database row and best-
effort deletes the corresponding S3 objects (original, analysis, thumbnail);
shared catalog rows (`albums`, `releases`) are never deleted, since other
users' library items may reference them. A future backup/lifecycle policy
should also cover backups and any orphaned S3 objects a failed best-effort
delete leaves behind (`docs/HANDOFF.md`'s known gaps). `store: false` is set
for OpenAI responses, but provider account data controls must also be
reviewed.

## Before multi-user/public deployment

Add a threat model, authorization integration tests, dependency/container
scanning, secret scanning, abuse controls, and an incident-response
contact/process. Account export/deletion is implemented (ADR-0014); a
published privacy notice describing this policy in user-facing terms is
still needed.
