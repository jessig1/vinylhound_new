# ADR-0032: Cover candidate capture is local and experimental

- Status: accepted for the P5.1 Task 1 implementation; detector selection and public rollout remain gated
- Date: 2026-09-28

## Context

Whole-scene stillness cannot establish that an album exists. P5.1 now precedes
the private phone/webcam detector evaluation in P5.2, so its implementation
must support candidate tracking without claiming measured album recognition.
Audited analysis-crop persistence is a separate P5.1 task.

## Decision

Replace whole-scene stillness with a local cover-candidate pipeline behind
`CAPTURE_CANDIDATE_MODE_ENABLED=true`, default false. With the flag disabled,
the live camera uses an explicit manual shutter; file upload stays available.

The initial replaceable detector is a small TypeScript edge/component and
quadrilateral geometry baseline in a same-origin Web Worker. It introduces
no provider, model assets, external dependency, or remote preview-frame calls.
It accepts plausible complete jacket boundaries and returns normalized
corners, crop-specific quality, and an illumination-normalized fingerprint.
Geometry cannot distinguish every book or screen from a jacket. P5.2 must
compare this baseline with OpenCV.js and, if needed, album-specific models
on private negative/held-out scenes before choosing the released detector.

Tracking uses time-based stability/removal/replacement, never background
motion or session-wide artwork deduplication. It retains the best frozen
source and its matching corners. Sampling is approximately 6 fps at a 320px
long edge, with one worker job and at most two retained source snapshots,
each capped at a 1600px long edge. Worker failure uses the manual recovery
path. Camera stop/pause invalidates callbacks and encoding results.

The crop is a perspective-corrected local preview only. Upload and analysis
continue to use the full accepted camera snapshot and the existing server
normalization/audit trail. No source/derivative contract or canonical image
relationship is introduced. Copy explains which image is used for analysis.
P5.1 Task 3 must decide and validate authoritative analysis crops in its own
ADR before changing persistence or public contracts.

Accepted camera photos immediately join the existing idempotent upload flow;
the scanner remains open until Finish scanning. This small part of Task 2 is
necessary to avoid per-album submit actions. A provisional admission bound
of 20 pending records / 32 MiB of local file bytes plus a worst-case encoding
reservation prevents slow uploads accumulating unlimited camera photos.
P5.1 Task 2 subsequently added quota/retry/rollover and refresh/cancel
handling to the browser queue, plus admission accounting for retained previews
and in-progress encoding. P5.2 still needs physical-device memory validation.

## Consequences and verification

Automatic capture remains off in deployed environments unless explicitly
enabled. Synthetic geometry, state, and browser tests verify wiring and
negative-scene behavior; they do not establish physical-device accuracy or
fulfil P5.2/P5.3 release gates. No pressing identity is inferred.

Use video frame callbacks where available, with a throttled timer fallback.
See [MDN video frame callbacks](https://developer.mozilla.org/en-US/docs/Web/API/HTMLVideoElement/requestVideoFrameCallback)
and [MDN worker bundling and transferable buffers](https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Using_web_workers).

## 2026-09-29: Layered guidance experiment

The baseline now combines luminance and RGB edge strength in two bounded
passes (strong edges and a scene-adapted threshold). Four-side support,
coverage, centering, perspective, and crop detail remain separate checks;
only a ready candidate can enter the existing 600 ms stability window.
Tentative quadrilaterals provide recovery guidance without being capture
candidates. Prefer the outer plausible boundary even when it is incomplete,
so a smaller artwork rectangle cannot override evidence of a clipped sleeve.
This can deliberately defer capture when a large background rectangle competes
with the album; manual capture remains the explicit recovery path.

The UI shows the checks and hold-steady progress instead of a purported album
confidence score. Instructions require 450 ms of persistence, and prolonged
searching offers practical lighting/background/manual suggestions. Weak
detail and low luminance together suggest lighting; brightness alone never
rejects a detected cover. Reflection advice is not a glare measurement.
Signals and frame buffers stay local, with no provider or HTTP contract
change. Synthetic tests demonstrate selected failure cases, not real-device
recall. P5.2 must still compare detector approaches on private footage.

ADR-0033 supersedes this ADR's original preview-only paragraph: accepted
source and exact preview crop are now linked private uploads, with analysis
derived from the crop. This experiment preserves that audit relationship.
