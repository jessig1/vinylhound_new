# P5.1 automatic capture release evaluation

Automatic capture is default-off. This sheet records the P5.1 Task 4 decision
for each physical setup; a simulated Playwright device is not a physical-device
result. Keep source video, crops, and any identifying device details in private
storage. Publish only aggregate counts and non-identifying failure descriptions.
The thresholds below come from the
[capture proposal](CONTINUOUS_CAPTURE_IMPROVEMENT_PLAN.md#acceptance-gates-and-verification).
P5.2 owns the detector/device baseline and P5.3 owns the private AI comparison.

## Run definition

Create one record per **physical device, browser, camera, detector version, and
test session**. Record the app commit, flag value, lighting, camera resolution,
browser version, and whether the device is supported. Do not combine iPhone
Safari, Android Chrome, and laptop Chrome/Edge webcam results to pass a gate.
If macOS Safari is offered as supported, give it its own record.

Use consented private video where possible. Label presentations and capture
events from the recording before scoring. A presentation begins when one
complete, usable cover enters the guide and ends when it leaves or is replaced.
Mark a partly clipped, unreadable, or deliberately challenging presentation
separately; do not quietly remove it from the denominator. Split development
and held-out clips by cover, person/background, and recording session. Never
count adjacent frames from one clip as independent presentations.

Use this sequence for each setup:

1. Record ten minutes without an album: empty scene, seated/moving person,
   hands, books, monitor, and changing light. Count every automatic capture.
2. Present at least 20 distinct covers in 100 supported-indoor presentations.
   Include dark, light, minimalist, glossy, and portrait artwork. Record each
   visible-start time, automatic-capture time, miss, and manual intervention.
3. Run 100 held-cover hold/move/lighting sequences, including a ten-second hold.
   Count captures after the first as duplicates.
4. Run 100 replacements, including similar-looking jackets and direct swaps.
   Record whether each new cover was captured without a manual shutter.
5. Inspect 100 accepted crops against their source frames. Mark complete front
   artwork and material background/user inclusion independently, plus clipped
   edges, wrong inner boundary, and unusable perspective.
6. Present ten albums in one session, with only the initial camera-start action.
   Record per-album shutter/submit actions, finish/review, retry, quota/capacity,
   and intentional duplicate-copy recovery.
7. For ten minutes, sample preview responsiveness, startup delay, detector
   frame time/backlog, and memory on the slowest supported device. Record any
   crash, thermal slowdown, permission loss, or stalled upload. Test the manual
   camera shutter and file upload after detector failure and permission denial.

Run the same identification configuration against source frames and linked
crops for the **same private albums**. Keep model, prompt, detail level, and
ground truth fixed. Report rank-1 artist/title correct counts and denominators
for both paths and paired wins/losses/ties. Do not infer pressing accuracy from
cover matches. This comparison must pass P5.3's predeclared sample and
acceptance rules before claiming an AI improvement.

## Per-setup result sheet

Copy this table for each setup. Use `not run` instead of an empty cell. Keep
counts even when the threshold fails; percentages alone hide sample size.

| Field                                                              | Result                      |
| ------------------------------------------------------------------ | --------------------------- |
| Setup / physical device / browser / camera                         | not run                     |
| App commit / detector version / flag / date                        | not run                     |
| Supported indoor conditions and camera resolution                  | not run                     |
| No-album automatic captures / observed minutes                     | not run / 0                 |
| Eligible album captures / eligible presentations / distinct covers | not run / 0 / 0             |
| Challenging or incomplete presentations / captures                 | not run / not run           |
| Warm capture latency p50 / p95 / timed captures                    | not run / not run / 0       |
| Extra captures / held-cover sequences                              | not run / 0                 |
| Captured replacements / replacement presentations                  | not run / 0                 |
| Useful crops / inspected accepted crops                            | not run / 0                 |
| Wrong inner boundaries / clipped edges / material background       | not run / not run / not run |
| Ten-album session: captured / presented / extra actions            | not run / 0 / not run       |
| Retry / intentional duplicate / Finish and review                  | not run / not run / not run |
| Cold-start delay / frame time p95 / max backlog                    | not run / not run / not run |
| Memory start / peak / end / crashes or thermal slowdown            | not run / not run / not run |
| Manual shutter / file upload recovery                              | not run / not run           |
| Private evidence location and labeling notes                       | not run                     |
| Decision and reason                                                | not evaluated               |

Pass only when all applicable gates hold **for this setup**: zero false
captures in ten minutes; at least 95/100 eligible presentations captured
across at least 20 distinct covers; warm latency p50 at most 1 second and p95
at most 1.5 seconds; zero extra captures in 100 held-cover sequences; at least
95/100 replacements captured; at least 95/100 crops useful; and a complete
ten-album session without per-album shutter or submit actions. The preview
must remain responsive with bounded memory and no frame backlog. Record cold
startup and thermal behavior separately. A gate with too few observations is
**not evaluated**, not passed.

## Current evidence and decision (2026-09-30)

A second private webcam recording (4m06s) was reviewed after the layered
guidance changes. Six distinct sleeves appear; the maintainer reports zero
successful scans, and sampled frames show repeated searching and amber outlines
on wall objects. During the yellow sleeve presentation, a wall calendar drives
move-back advice despite the sleeve being visible. This also fails exploratory
usability; eligible presentation counts, continuous capture events, and exact
runtime revision are not instrumented. See the
[detailed review and next experiments](CAPTURE_VIDEO_REVIEW_2026-09-30.md).
Neither recording supplies a formal per-setup gate denominator.

| Setup                                             | Observed counts                                                                                                                                                                                                                 | Gate result                                                                                                                                                     |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Laptop webcam, private 81-second screen recording | Three distinct sleeves were presented. One began an automatic upload; two stayed in “Looking for a cover.” The one tracked outline followed dark inner artwork, and the jacket's lower outer edge was outside the camera frame. | Failed exploratory recall/crop trial. The clip lacks a ten-minute negative interval and the full gate denominators, so it cannot qualify the setup for rollout. |
| iPhone Safari                                     | No physical-device recording or result available.                                                                                                                                                                               | Not evaluated.                                                                                                                                                  |
| Android Chrome                                    | No physical-device recording or result available.                                                                                                                                                                               | Not evaluated.                                                                                                                                                  |

This clip remains private and was not added to the repository. Its three
presentations are an exploratory observation, **not** a 100-presentation recall
estimate: the incomplete jacket needs its own label, and upload start does not
prove backend completion. The current geometry detector is therefore not
approved for any public setup. Keep `CAPTURE_CANDIDATE_MODE_ENABLED=false` in
public environments. Manual camera capture and file upload remain available.
If a later setup passes every gate and the P5.3 comparison, enable only that
documented setup through a reviewed rollout plan; restore the flag to `false`
if false captures, misses, or crop failures recur.
