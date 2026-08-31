# ADR-0007: Normalize images at upload completion, not at analysis time

- Status: accepted
- Date: 2026-08-30

## Context

The AI identification pipeline read each scan's original uploaded bytes
directly and base64-encoded them into the OpenAI request. Originals can be up
to 25 megapixels and 10 MB (`packages/storage`'s validation cap), and
multi-view/batch scans (ADR-0006 and the prior multi-view slice) can send up
to 12 images per scan or N independent images per batch. Every one of those
requests paid full-resolution encode/transfer/token cost, and no smaller copy
existed anywhere for a future UI preview.

Two placements were considered for a resize step:

1. Resize in the worker, in-memory, immediately before building the OpenAI
   request payload. No schema or storage change, fully reversible, but
   repeats the same resize on every delivery retry and produces nothing
   reusable for a UI thumbnail.
2. Resize once, when an upload is marked complete (`POST
.../uploads/{imageId}/complete`), where the bytes are already fetched and
   decoded through `sharp` for `validateImage`. Persist the result as new
   objects and reuse them from every later read.

## Decision

`POST .../uploads/{imageId}/complete` derives two additional JPEG copies from
the already-decoded original after validation succeeds: an analysis copy
(long edge capped at 2048px, quality 82) and a UI thumbnail (long edge capped
at 400px, quality 70), via a new `normalizeImage` function in
`packages/storage`. Both are stored as new S3 objects at
`{userId}/{scanId}/{imageId}/analysis` and `.../thumbnail`, sibling to the
existing `.../original` key (object key derivation is now the shared
`deriveImageObjectKey` helper in `packages/database`). `image_assets` gains
nullable `analysis_size_bytes`/`analysis_width`/`analysis_height`/
`thumbnail_size_bytes` columns (migration 009), populated together with
`completed_at` and covered by the same before/after check-constraint pattern
already used for `width`/`height`.

`prepareScanAnalysis` now returns the analysis object's key, fixed
`image/jpeg` MIME type, and size instead of the original's; the worker's
analysis handler is unchanged; it already reads whatever object key
`prepareScanAnalysis` gives it. Neither retry nor redelivery re-normalizes
anything — they reuse the stored analysis copy.

Worker concurrency limiting was believed to be a gap for this slice, but
`ANALYSIS_CONCURRENCY` (`packages/config`, wired into BullMQ's `Worker`
`concurrency` option in `apps/worker`) already existed since Milestone 1 and
needed no change; the roadmap/handoff note describing it as missing was
stale.

## Consequences

- Every OpenAI request now sends the capped analysis copy instead of the
  original, cutting per-image upload payload/token cost roughly in
  proportion to the resize (most phone photos exceed 2048px on the long
  edge); this reduces, but does not eliminate, the cost/latency scaling
  called out for multi-view and batch in prior sessions' known gaps. It is
  not yet measured against the deferred eval baseline.
- Upload completion does more work per image (two additional `sharp`
  encodes, two additional S3 PUTs) and stores roughly 1.15x the original's
  bytes across three objects instead of one; this trades upload-time latency
  and storage for cheaper, faster, and repeatable downstream reads.
- The stored thumbnail is not yet read anywhere — no UI currently renders an
  uploaded image — but its cost is already paid, so wiring a preview into the
  result/history pages later needs no further backend change.
- `image_assets.mime_type`/`size_bytes`/`width`/`height` continue to describe
  the original as uploaded; they are unrelated to the derived copies and the
  public `CompleteImageUploadResponse` contract is unchanged.
- No S3 object cleanup exists for any of the three variants when a scan or
  image is deleted; this was already true for the original and remains a
  known gap, not one introduced or widened by this change.
