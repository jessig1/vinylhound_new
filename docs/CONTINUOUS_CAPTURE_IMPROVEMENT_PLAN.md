# Continuous capture: research and improvement plan

Date: 2026-09-19. Status: proposal; no application changes implemented.

## Recommendation

Replace whole-scene stillness capture with an album-aware browser pipeline:
detect a candidate cover, follow its boundaries, check image quality, capture
one clear crop, and wait for another album. Keep artist/title identification in
the existing asynchronous worker. Starting scanning should be one user action;
individual albums should require no shutter or submit click.

Plan for both a phone pointed at records and a laptop/webcam with the user
holding albums up. The latter is particularly important for reproducing the
reported captures of the user without an album. Device priority was asked during
research but was not established when this plan was written.

Start with an OpenCV.js boundary-detection experiment on representative video.
Do not treat finding a square as proof of an album. If geometry cannot meet the
false-capture and recall gates below, add a small album-specific detector before
releasing the improved automatic mode. A generic document scanner alone is not
enough evidence that the handheld workflow will work reliably.

## Current project state and root causes

The existing architecture already supports signed uploads, independent scans,
bounded upload concurrency, asynchronous analysis, idempotency, quota checks,
batch rollover, and later review. Those are useful foundations. The missing
capability is deciding what and when to photograph.

Evidence from the current working tree:

| Finding                                             | Evidence                                                                                                                           | User-visible consequence                                                                                                                                  |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No album detection                                  | `apps/web/src/app/scan/capture-session.tsx`, `inspectLiveCameraFrame`                                                              | Any still scene can be captured, including a person or an empty room.                                                                                     |
| Stillness across the entire image                   | Full frame stretched to 96 x 96; samples every 250 ms; four successive low-difference comparisons; mean RGB difference threshold 7 | Background motion, camera movement, or exposure changes can prevent capture even when the album is usable. A motionless person can satisfy the same gate. |
| Rearming measures scene change                      | Two samples with mean difference at least 18 from the last captured frame                                                          | Removing an album rearms the scanner; the now-still person/background can become the next capture. Similar-looking replacements may fail to rearm.        |
| Guide does not define the saved area                | `apps/web/src/app/globals.css`, `.live-camera__viewfinder`; `captureLiveCameraFrame` saves the full video dimensions               | The visible inset is decorative. `object-fit: cover` can also conceal camera pixels that are included in the saved image.                                 |
| No crop or perspective correction downstream        | `packages/storage/src/image-normalization.ts` rotates/resizes/re-encodes the supplied image                                        | Normalization still includes the user and background in the analysis image.                                                                               |
| No quality gate or requested resolution             | Camera request only specifies preferred environment-facing camera; sampler measures pixel change                                   | Stillness does not establish focus, readable cover detail, acceptable glare, or a complete cover. Actual resolution is device-dependent.                  |
| Capture and upload remain separate                  | `captureLiveCameraFrame` adds an idle record; `startSession` enqueues idle records                                                 | Automatic photos still need a later session-start action for analysis. Newly captured records do not automatically join an active upload queue.           |
| Session can leave the camera page                   | `processRecord` navigates when pending count reaches zero                                                                          | Automatically uploading as each album appears also requires changing this navigation behavior.                                                            |
| Local memory is not explicitly bounded at admission | Capture increments `pendingCountRef` without checking a local item/byte ceiling                                                    | Upload concurrency of three does not bound the number or bytes of local captures.                                                                         |
| Tests do not prove album recognition                | `apps/web/e2e/live-camera.e2e.ts` supplies uniform black/white pixel arrays                                                        | The test expects a blank scene to capture. It exercises transitions, not whether the target exists.                                                       |

These code paths explain the reported behavior, but this session did not run a
physical camera reproduction. The deployed revision was not checked against the
local tree. The handoff also records a recurring failure in the first live-camera
browser test; that history was read, not independently rerun here.

P3.2 is recorded as complete after a 9/10 capture, zero-duplicate phone protocol.
That protocol does not establish an acceptable false-capture rate during long
periods without an album, diverse backgrounds, or webcam use. Keep that historical
result, but add a new reliability milestone. Some handoff text is stale: its
claim that batch rollover is unimplemented conflicts with `createNextBatch` and
the existing `batch_scan_limit` handling. Use implementation evidence when
planning follow-up work. The unrelated P4.2 service extraction is not a
prerequisite for this improvement.

## What other scanners demonstrate

ManaBox documents border detection, recommends contrasting backgrounds and low
glare, and identifies cards by artwork. It offers focus controls, scan sounds,
session review, and a way to deliberately scan the same artwork again.
[ManaBox scanner guide](https://manabox.app/guides/scanner/getting-started/).

Its FAQ explains that reused artwork can yield the wrong printing, requiring
correction. Album artwork similarly cannot establish a vinyl pressing.
[ManaBox scanner FAQ](https://manabox.app/guides/scanner/faq/).

The public material reviewed does not disclose ManaBox's exact detector,
recognition model, hashing scheme, or processing location. Border detection plus
artwork matching is supported; attributing OpenCV, a particular neural network,
or entirely offline recognition to ManaBox would be speculation. The proposed
VinylHound pipeline below is our design, not a description of their internals.

Google's Android ML Kit document scanner explicitly supports on-device document
detection, automatic capture, edge cropping, and rotation. It demonstrates the
interaction pattern, but its Google Play services integration is not a browser
API we can drop into this Next.js application.
[ML Kit document scanner](https://developers.google.com/ml-kit/vision/doc-scanner).

Cards have a constrained shape and artwork catalog. Vinyl jackets can be dark,
borderless, glossy, partly covered by hands, or indistinct from a busy background.
My inference is that adopting the scanning interaction is practical, while
matching card-scanner reliability requires album-specific evaluation.

## Technology options

| Approach                                                  | Useful capability                                             | Limitation and recommendation                                                                                                                                               |
| --------------------------------------------------------- | ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Canvas motion thresholds alone                            | Cheap stillness signal                                        | Already present; cannot distinguish an album from a person. Keep motion only as one quality signal within a detected cover.                                                 |
| OpenCV.js geometry                                        | Edges, contours, four-corner outlines, perspective correction | Recommended first experiment. Rectangles can be books/screens; low contrast and hand occlusion can defeat edges. Benchmark before shipping.                                 |
| Small trained model through ONNX Runtime Web or MediaPipe | Album-presence confidence and localization                    | Escalation if geometry fails; likely useful for webcam/cluttered scenes. Requires appropriate weights, consented data, model evaluation, and measured loading/runtime cost. |
| Existing JavaScript document-scanner wrapper              | Quick feasibility prototype                                   | Paper detection is not album detection. Review dependencies, behavior, and licensing before adoption.                                                                       |
| Remote vision call on every preview frame                 | Flexible semantic analysis                                    | Adds network delay, uploads unrelated frames, and consumes analysis capacity. Keep remote recognition after a local acceptance decision.                                    |
| Native mobile document scanner                            | Mature platform camera/scanner UI                             | A separate application effort; does not solve laptop/browser capture. Not required for this plan.                                                                           |

OpenCV.js supplies [contour detection](https://docs.opencv.org/4.x/d5/daa/tutorial_js_contours_begin.html),
[polygon approximation and geometry](https://docs.opencv.org/4.x/dc/dcf/tutorial_js_contour_features.html),
and [four-point perspective transformation](https://docs.opencv.org/4.x/dd/d52/tutorial_js_geometric_transformations.html).
An existing [OpenCV.js document-scanner implementation](https://github.com/tony-xlh/opencvjs-document-scanner)
provides a concrete boundary-detection/cropping reference; it is not validated
for VinylHound or selected as a dependency by this proposal.

MediaPipe supports custom models and returns boxes/classes/confidence, but its
video detection calls block the calling thread, so camera processing belongs in
a worker. Its supplied COCO
[label list](https://storage.googleapis.com/mediapipe-tasks/object_detector/labelmap.txt)
does not include vinyl jackets. A `book` or `person` prediction is not an adequate
album gate. [MediaPipe Web guide](https://developers.google.com/edge/mediapipe/solutions/vision/object_detector/web_js).

ONNX Runtime Web offers a browser inference runtime, not an album model. Use
WebAssembly as the compatibility baseline, with optional acceleration selected
by actual capability and performance checks.
[ONNX Runtime Web](https://onnxruntime.ai/docs/get-started/with-javascript/web.html).
Start with single-threaded inference inside a dedicated worker; WASM
multithreading additionally requires cross-origin isolation, which needs review
against the application's authentication and resource loading.
[ONNX runtime configuration](https://onnxruntime.ai/docs/tutorials/web/env-flags-and-session-options.html).

## Proposed capture behavior

1. **Start scanning once.** Open the selected camera, initialize the detector,
   and explain that accepted covers are automatically queued for analysis.
   Prefer the rear camera on phones; allow webcam/camera selection. Request a
   useful ideal resolution and inspect actual settings, with graceful fallback.
2. **Wait for an album.** Show a square guide and an outline following the
   detected cover. No qualifying candidate means no capture, regardless of how
   still the person or room is. If several albums compete, request one at a time.
3. **Qualify the candidate.** Check plausible jacket geometry, useful pixel size,
   complete framing, boundary confidence, candidate motion, and crop quality.
   Prefer the candidate in the intentional guide region. Avoid rigid
   screen-space square/angle rules that reject a tilted square jacket.
4. **Select a clear frame.** Track the same candidate across a short time window;
   choose the best available frame from a small bounded buffer. Begin experiments
   around 400-700 ms of usable stability, not a universal hard-coded promise.
   Do not require the background to remain still.
5. **Capture and crop once.** Freeze the source frame and its matching corner
   coordinates together. Produce a color-preserving crop, rectify perspective
   where reliable, and retain the full artwork. Confirm with a thumbnail, text,
   optional sound, and vibration where supported. Say "Captured", not
   "Identified", until analysis returns.
6. **Continue while analysis runs.** Queue the accepted item immediately using
   stable per-record idempotency keys. Remain on the scanner page. Provide a
   visible queue count, per-item recovery, and a deliberate Finish/review action.
7. **Recognize the next presentation.** Lock out the current tracked album until
   sustained removal or a confidently different cover appears. Empty space
   rearms detection but never creates a record. Ignore background motion and
   exposure changes when deciding whether a new album is present.

The intended state sequence is:

```text
searching -> qualifying -> capturing -> waiting for next album
                 |                          |
          target lost: searching     removal: searching
                                     different cover: qualifying

Any active state -> paused (capacity, hidden tab, access loss, user stop)
```

Use time-based hysteresis: entry into a state needs sustained evidence, and one
bad frame must not reset a good track. Begin testing removal around 250-400 ms.
Track overlap/corners plus a fingerprint of the normalized album crop. A
perceptual hash is a duplicate hint, not proof of identity or pressing: similar
covers must not silently disappear from the collection workflow. Suppress a
continuously held album; permit the same album after genuine removal/reintroduction
and offer "Scan another copy" for deliberate exceptions. Do not deduplicate all
matching artwork across a session.

Avoid face-based rejection: a person can hold a valid album, and cover artwork
can contain faces. Positive album evidence is the relevant gate. A severe-glare
or blur signal should prompt "Tilt slightly" or "Hold steady"; white/black album
art must not be rejected just because of its brightness. A missing detection
must never time out into an automatic whole-scene capture.

## Browser processing and integration

- Extract camera lifecycle, frame analysis, and transition policy from the large
  capture component behind a detector interface. Keep browser concerns under
  `apps/web`; use pure functions for geometry and transition tests.
- Start benchmarking around 5-10 analyzed frames/second at a 320-640 pixel long
  edge, preserving aspect ratio. These are experiment settings. Adapt sampling
  to device load and skip frames while an analysis is already running.
- Prefer `requestVideoFrameCallback` to avoid repeatedly scoring the same video
  frame; feature-detect and use a guarded fallback for older browsers.
  [MDN video frame callbacks](https://developer.mozilla.org/en-US/docs/Web/API/HTMLVideoElement/requestVideoFrameCallback).
- Use a dedicated Web Worker for expensive detection. Feature-detect
  OffscreenCanvas; fall back to small transferred frame buffers if needed.
  [MDN OffscreenCanvas](https://developer.mozilla.org/en-US/docs/Web/API/OffscreenCanvas).
- Lazy-load pinned runtime/model assets when scanning starts, host them under
  controlled origins, and validate CSP and production bundling. Bound the frame
  buffer, close transferred bitmaps, release OpenCV allocations, and stop the
  worker and media tracks on exit. Do not accumulate preview history.
- Map source-video, sampled-image, CSS-preview, orientation, and mirrored-preview
  coordinates explicitly. Save an unmirrored image even when a selfie preview is
  mirrored. Test portrait and landscape sources; a CSS outline alone is not a crop.
- Reserve a queue slot before asynchronous encoding. Check both item and byte
  limits, including in-flight images, then transfer/release the reservation on
  enqueue, failure, or cancellation. Choose ceilings from device measurements;
  upload concurrency and server quota are separate bounds.
- Preserve background/access-loss pauses and explicit resume, quota enforcement,
  signed URLs, cancellation, upload validation, batch rollover, and refresh
  recovery. Cancel stale detection/encoding results with a session generation
  identifier so stopping/restarting cannot append an old capture.
- Provide manual capture/file upload when detection is uncertain or unsupported.
  It is an explicit recovery path; the default successful workflow is hands-free
  after session start. Do not auto-confirm identification or collection entries.

## Cropping and the audit trail

This feature needs a deliberate image-contract decision. Today the uploaded
original produces both the analysis derivative and thumbnail. Uploading a crop
as an unrelated second front-cover image would send both images as evidence and
would not solve the background problem.

Recommended implementation direction: preserve the accepted source image
privately, associate a cropped analysis derivative with it, and send only that
derivative for automatic front-cover identification. The preview should match
the derivative used for analysis. Preview frames that fail the gate stay in
memory and are discarded.

The browser can render a crop immediately. Before production integration, choose
and benchmark where the authoritative derivative is created: a validated browser
crop linked to its source, or a server-generated crop from a validated source and
quadrilateral. Existing Sharp normalization alone does not implement four-point
perspective warping. Select that processing dependency explicitly; do not assume
the existing resize function performs it.

Record source and derivative checksums/dimensions, oriented source coordinates,
ordered corners, detector/model and crop-transform versions, and capture time.
Treat client quality scores as untrusted hints. Validate bytes and geometry
server-side, preserve ownership/idempotency, and keep prompt/model attempt
provenance. A client-declared source/derivative relationship is not independent
proof that the derivative was produced correctly.

This means an accepted original can still contain the user even though the
analysis image does not. Explain that accurately in capture/privacy copy. If the
desired rule becomes "background pixels must never be uploaded or retained",
define the on-device crop as the capture original through an explicit retention
and audit-policy decision; do not silently discard the source under the current
original-image requirement.

Write an ADR before implementing these persistence/public-contract changes.
Update contracts and freeze old/new fixtures before implementations; preserve
old uploads without crop metadata, tolerant browser readers, and independent
deployment compatibility. Coordinate image fields with ADR-0027's scan ownership
without waiting for the entire P4.2 extraction.

## Phased implementation plan

| Phase                        | Work and concrete deliverable                                                                                                                                                         | Exit condition                                                                                                                                   |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1. Reproduce and measure     | Private consented clips of album/no-album transitions on phones and webcams; instrument rejection reasons, timing, and capture counts; characterize the existing browser-test failure | Baseline false captures, misses, duplicates, latency, and crop coverage are recorded separately from AI recognition accuracy.                    |
| 2. Detector feasibility      | Compare OpenCV.js quadrilateral detection with a suitable lightweight model candidate if needed; measure loading, frame time, recall, and false positives on held-out scenes          | A detector meets the gates for each supported workflow; otherwise document the gap and required model/data work before rollout.                  |
| 3. Capture engine and UI     | Candidate tracking, quality selection, crop preview, duplicate handling, camera selection, feedback, bounded buffers, and lifecycle cancellation behind a feature flag                | Recorded-frame tests and actual devices demonstrate album-only triggering and correct cropping.                                                  |
| 4. Audited image integration | ADR, compatible crop/source contracts and fixtures, derivative creation, storage/provenance, server validation, worker/thumbnail selection, updated privacy copy                      | Analysis receives the crop; original and transform remain traceable; legacy/manual uploads and multi-view scans retain their intended semantics. |
| 5. Continuous submission     | Incremental automatic enqueue, local item/byte bounds, quota pauses, retries, rollover, and explicit Finish/review navigation                                                         | Ten albums can be presented sequentially without per-album shutter/submit actions, while slow upload/analysis cannot exhaust memory.             |
| 6. Validate and roll out     | Real-device matrix, recognition comparison, aggregate diagnostics, feature-flag rollout and rollback                                                                                  | All acceptance gates pass; unsupported cases have a clear recovery path.                                                                         |

Keep the first experiment small enough to reject a weak approach quickly. If a
model is necessary, obtain album-specific training/validation data with hard
negatives and split by album, person/background, and recording session. Adjacent
frames from one clip must not appear on both sides of evaluation. Runtime support
does not establish model accuracy or permission to redistribute weights. Review
model/data licenses and reconcile any training work with `docs/PRODUCT.md`'s
training non-goal before proceeding. Do not promise a training duration or a
sufficient dataset size before measuring the gap.

## Acceptance gates and verification

These are proposed product targets, not results achieved during this research.
Report counts and denominators per device/workflow, not only a pooled percentage.

| Metric                        | Proposed gate                                                                                                                                                                         |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| False captures without albums | Zero during a 10-minute scripted no-album session per target setup, including a seated/moving person, empty room, hands, books, monitors, and changing light.                         |
| Album capture recall          | At least 95 of 100 presentations per target setup across at least 20 distinct covers under supported indoor conditions. Record challenging-condition results separately.              |
| Capture latency               | Warm scanner: median at most 1 second and p95 at most 1.5 seconds after a sufficiently visible, usable cover enters the guide. Measure cold-start loading separately.                 |
| Held-cover duplicates         | Zero across 100 hold/move/lighting sequences, including a 10-second hold and mild hand movement.                                                                                      |
| Replacement detection         | At least 95 of 100 replacements captured, including similarly colored albums and direct swaps without a long empty interval.                                                          |
| Crop usefulness               | At least 95 of 100 accepted crops retain the complete front artwork without materially including the user/background; inspect corner error and edge clipping as well as overlap.      |
| End-to-end usability          | Ten albums scanned with one session-start action and no per-album shutter/submit actions; explicit completion/review; retry and intentional duplicate-copy recovery work.             |
| Recognition impact            | Compare full-frame and cropped inputs on the same private album set with the same identification settings. Improve or preserve artist/title accuracy; do not claim pressing accuracy. |
| Performance                   | Responsive preview and controls, bounded memory over a 10-minute session, no backlog of frame jobs, and measured startup/thermal behavior on the slowest supported device.            |

Zero observed failures in a finite test is a release gate, not a guarantee of zero
real-world failures. Keep sanitized production counts/rejection reasons so the
thresholds can be revisited without logging photos or signed URLs.

Cover iPhone Safari, Android Chrome, and laptop/desktop Chrome or Edge webcams;
add macOS Safari if supported. Include dark/light/minimalist covers, portrait
artwork, glossy sleeves, glare, slight tilt, fingers over edges, cropped-off
jackets, multiple albums, foreground/background movement, camera switching,
permission loss, tab hiding, rotation, throttled upload, capacity exhaustion,
and stopping during encoding or inference.

Replace the blank-frame-as-album test assumption with detector-independent state
tests plus synthetic rectangle/negative-image tests and private video evaluation.
Test same-cover movement, absent-cover intervals, direct replacement, exposure
changes, pause/resume, stale callbacks, pending-buffer limits, and coordinate
mapping. Browser emulation still does not establish physical-camera performance.
For implementation, run `npm run check`, `npm run build`, the browser matrix,
contract compatibility for changed contracts, and image/storage integration checks.

## Research-session verification

Only this proposal and the required handoff update are part of this research
session; existing unrelated working-tree changes are preserved. No application,
dependency, configuration, schema, or test implementation changes were made.

Before document edits, `npm run check` stopped at Prettier with 75 existing file
warnings. Consequently that command did not reach lint, typechecking, or tests.
No formatting cleanup was applied to application files. Real-camera accuracy,
crop performance, and model suitability remain unmeasured until Phase 1/2.
Targeted Prettier checks passed for this plan and `docs/HANDOFF.md`, and
`git diff --check` passed. The application/package diff remained empty.
