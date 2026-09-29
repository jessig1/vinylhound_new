# ADR-0033: Audited analysis crops for automatic captures

- Status: accepted
- Date: 2026-09-29

## Context

ADR-0032 keeps the accepted camera frame and a local perspective crop, but
uploads only the frame. Analysis therefore sees a different image from the
preview. The original frame is necessary for review and for recovering from a
bad detector boundary. A crop is a candidate presentation, not proof of a
particular record or pressing.

## Decision

One `image_assets` row owns one accepted source and, optionally, one analysis
crop. The source remains the existing private `original` object. Automatic
capture uploads the exact JPEG shown as its crop preview to a separate private
`crop` object using a second signed PUT. The upload request declares the crop's
size, SHA-256, dimensions, normalized source-space corners, transform version,
and UTC capture time. The source declaration includes its dimensions. The
server persists those declarations with the image row, including the source
checksum already stored there. An idempotency-key replay with changed crop
provenance conflicts.

Completion reads and validates both objects: declared and decoded type, byte
count, checksum, source/crop dimensions, a bounded non-self-intersecting
quadrilateral with meaningful area, and supported transform version. A missing
or invalid crop fails completion. Only after validation does the server derive
the `analysis` and `thumbnail` objects from the crop. For legacy/manual/file
and additional-view uploads, crop fields are absent and those derivatives
continue to come from the full source. The worker keeps reading the `analysis`
object; the selected input is fixed when upload completion succeeds. No crop
data is sent to the AI provider except those analysis pixels.

The source, crop, analysis, and thumbnail share the image's owner/scan/image
key prefix and deletion lifecycle. Neither source nor crop gets a public URL.
The browser previews the exact local crop bytes it uploaded. Retaining the
source allows a future reviewer to diagnose or redo a poor crop without
inventing a new original. EXIF remains possible in the source; generated
camera JPEGs and server derivatives do not carry it. The existing account
deletion process removes all four variants.

## Consequences

Automatic capture incurs one additional signed upload and storage object.
This is bounded by the existing image size and local queue limits. Crop
geometry and bytes are independently checked, but the server does not prove
that the crop's pixels were mathematically generated from the claimed corners;
that would require a second perspective renderer and comparison tolerance.
The detector and public rollout remain gated by P5.2/P5.3 evidence.
