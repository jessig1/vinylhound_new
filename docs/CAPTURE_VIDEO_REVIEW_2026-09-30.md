# Webcam capture review: 2026-09-30

## Evidence and limits

Reviewed sampled frames across the maintainer's private 4m05.93s screen
recording, with full-resolution inspection of representative failures. The
recording is 1128x832 at 30 fps. Six distinct sleeves are visible; the maintainer
reports no successful scans, and the sampled UI remains in searching without
an accepted capture. These are exploratory observations, not a scored recall
denominator or proof that no brief state transition occurred between samples.
Video and extracted frames remain outside the repository.

The UI matches the layered-guidance implementation in checkout `a33dc98`;
the recording alone does not establish the running server's exact revision.
No detector trace, raw camera stream, network log, or backend completion record
accompanies it. Do not replay the screenshot's viewfinder as if it were raw
camera input: its guide, amber outlines, and status badge introduce edges that
the live detector did not receive.

## What is visible

Times are approximate ranges from five-second sampling.

| Time      | Observation                                                                                                                                                                                           | Interpretation                                                                                                                                   |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| 0:00-1:45 | The Black Crowes sleeve is repeatedly repositioned, presented seated and standing, and taken toward a window. Reflections and motion vary. Amber outlines sometimes follow wall objects.              | There are challenging frames, but repeated searching cannot be attributed solely to insufficient holding time or one lighting condition.         |
| 1:50-2:35 | The Book of Mormon sleeve is large and readable. Some presentations approach the camera boundary; others show the jacket within the camera image. The UI alternates searching and move-back guidance. | Distinguish actual clipping from an incorrect selected outline. Being outside the white guide is not the same as being outside the camera image. |
| 2:40-3:00 | A dark sleeve is presented near the bright window and then away from it. Wall objects again receive outlines.                                                                                         | Backlighting is a plausible contributor, but incorrect target selection is directly visible.                                                     |
| 3:05-3:20 | Elton John's Madman Across the Water is visibly presented with reflective wrapping.                                                                                                                   | Glare can impair some frames; no usable album candidate is visible in the sampled UI.                                                            |
| 3:25-3:40 | MF DOOM's MM..FOOD is large and readable, with the jacket contained in the view. A wall frame at the right sometimes gets the amber outline.                                                          | A colorful, detailed cover is also missed. More interior texture alone does not solve boundary detection.                                        |
| 3:50-4:00 | The yellow Blind Melon sleeve is fully in view. The amber outline follows the partly visible wall calendar at the left, while guidance says to move back.                                             | The advice describes the wrong object. This is the clearest evidence of a candidate-selection and guidance failure.                              |

The prior 81-second review recorded one yellow-cover upload beginning with
the dark inner artwork selected and the outer jacket clipped. That was an
incorrect crop, not a validated jacket-detection success. The new trial still
represents a practical failure: even a fully visible jacket cannot be captured.
The exact old/new contribution needs replay on identical raw inputs.

## Code-supported diagnosis

1. **The capture gate has no learned album recognition.** `cover-detector.ts`
   uses color/luminance gradients, connected edge components, convex hulls,
   quadrilateral approximation, and hard geometric checks. The downstream
   identification model only receives an image after capture/upload. Changing
   that model or its prompt cannot resolve the observed searching state.
2. **Unrelated rectangles can govern the result.** At lines 398-413, all
   proposals, including rejected ones, are sorted by area and the largest is
   selected. There is no requirement that a larger rejected shape contain the
   smaller album candidate before it blocks that candidate. The nested-artwork
   safeguard therefore applies globally. Background outlines in this recording
   directly demonstrate incorrect targeting; without proposal traces we cannot
   say a valid album proposal existed in each affected frame.
3. **Proposal generation is fragile around hands and clutter.** Edges must
   form a component whose simplified quadrilateral retains at least 90% of its
   convex-hull area. Fingers can interrupt or join boundaries; artwork and
   background can join the same component. The selected shape then needs 65%
   edge support on every side. These mechanisms plausibly explain absent
   sleeve proposals; per-frame traces are needed to assign exact rejection
   causes. The 320px input may aggravate small boundary losses, but increasing
   resolution alone does not add semantic understanding.
4. **Tracking cannot rescue missing candidates.** The tracker requires a
   ready candidate across a 600ms qualification interval, resets after gaps
   over 300ms, and restarts for corner/fingerprint movement. Intermittent
   proposals can prevent capture even when a person is holding an album still.
   This is a secondary risk, not an established explanation for every miss.
5. **Feedback hides what is known.** All false or unavailable checks render
   as "checking", and detail is not computed when earlier gates reject a
   proposal. The UI can therefore suggest that focus is still being evaluated
   when the real problem is no trustworthy target. Guidance persists through
   transient reason changes and is not tied to a tracked object identity.

The earlier `ensureDevelopmentUser` database error is a separate unresolved
upload/persistence issue. Local camera detection runs before that insert.
Nothing in this recording establishes a database failure as the cause of the
wrong outlines or searching state; backend success still needs separate
verification once captures trigger.

## Recommended improvement sequence

1. **Make failures reproducible.** Add an opt-in local diagnostic recorder
   for raw camera frames, all proposals, rejection stages, selected object,
   tracker resets, capture events, and timings. Keep private artifacts outside
   git. Label outer jacket corners, visibility/occlusion, and presentation
   intervals. Use these two recordings for development evidence; obtain new
   sessions, covers, and backgrounds for held-out evaluation.
2. **Repair target selection and feedback first.** Rank candidates using
   guide overlap, centrality, boundary evidence, and persistence. An incomplete
   outer shape should block an inner crop only when spatial containment and
   tracking support their belonging to the same object. Background persistence
   or foreground motion can be supporting evidence, never album proof. Once
   acquired, keep an object identity across brief detection misses. Only give
   clipping/distance instructions for a credible target; expose "not found",
   "blocked", and "not evaluated" distinctly. Make manual recovery prominent
   after prolonged failure.
3. **Benchmark stronger localization.** Compare the repaired baseline with
   OpenCV contour/line proposals and corner refinement on the same labeled raw
   inputs. [OpenCV provides contour approximation and hull operations](https://docs.opencv.org/4.13.0/dd/d49/tutorial_py_contour_features.html);
   these operations alone do not establish that a rectangle is an album. If
   this comparison still fails the existing gates, evaluate a compact model
   trained for record sleeves, with hands, inner artwork, books, calendars,
   monitors, wall frames, glare, and backlighting represented in evaluation.
   This model should locate sleeves across unseen artwork, not memorize album
   identities. Runtime choice is a later measured decision:
   [MediaPipe supports trained object detectors and video input](https://developers.google.com/edge/mediapipe/solutions/vision/object_detector/web_js),
   and [ONNX Runtime Web supports browser inference](https://onnxruntime.ai/docs/tutorials/web/).
   Neither runtime supplies evidence of album accuracy. Preserve bounded worker
   execution and measure device support, download size, latency, and memory.
4. **Separate locating a sleeve from obtaining a perfect crop.** Evaluate
   a high-confidence sleeve plus adequate image detail as a capture decision,
   with precise four-corner rectification as a separate confidence decision.
   A source-image fallback could avoid rejecting an identifiable sleeve when
   a hand obscures an edge. It must retain the source audit trail, duplicate
   control, user review, and honest crop provenance; never fabricate confident
   corners. This is a proposed behavior change requiring design/contract review,
   not a change made by this review. Use paired source/crop identification
   results to decide when cropping actually improves artist/title recognition.
5. **Score the user outcome.** Count captures per eligible presentation,
   false captures during no-album intervals, wrong-object/inner-artwork crops,
   duplicates, replacement recall, time to capture, and artist/title accuracy
   separately. Stratify glare, dark covers, hand occlusion, and background
   clutter. Do not count adjacent video frames as independent successes or
   use this development clip as held-out proof. Apply the existing per-device
   gates in `CAPTURE_GATE_EVALUATION.md` before public rollout.

The next implementation should be a measured target-selection repair with
private replay instrumentation, followed by the detector comparison. Lowering
all thresholds or increasing hold time would leave the demonstrated wrong-object
selection unresolved. A learned sleeve localizer is a justified experiment if
geometry remains unreliable, not a selected or validated replacement yet.

## Review outcome

The layered guidance trial failed in ordinary handheld use. Keep public
automatic capture default-off. This review changes documentation only; it does
not claim a runtime fix, model training, raw-frame replay, backend repair, or
formal release-gate result.
