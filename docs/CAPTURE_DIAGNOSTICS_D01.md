# P5.1-D01: local frame-decision diagnostics

Date: 2026-09-30. Decision: **keep the diagnostic tooling**. Detector selection,
thresholds, capture policy, and public default-off behavior remain unchanged.
This completes D01's synthetic tooling check, not D02's real-camera baseline.

## Reproduce a failure privately

1. Run the development web app with `CAPTURE_CANDIDATE_MODE_ENABLED=true` in
   the local root `.env`. Restart the server after changing the flag. Open
   `/scan` on localhost or HTTPS and start the live camera.
2. Expand **Local capture diagnostics (development)** below the viewfinder.
   Enter the running app's git revision, including `dirty` for uncommitted
   changes. This value is explicitly operator-entered, not build attestation.
3. Select **Include private raw frames** only for a consented recording. With
   it unchecked, the recorder retains numeric traces only. Start recording,
   then present the sleeve and reproduce the problematic guidance.
4. Stop recording, or let a declared limit stop it. Export the numeric trace
   and, separately, the private raw frames. Save both **outside the repository**.
   Stop retains the bounded recording for export; Discard, starting a new
   recording, or leaving the page releases it. Nothing survives refresh.

The panel exists only in development. Diagnostics start off and never persist
their opt-in state. There are no diagnostic network calls, browser-storage
writes, console image logs, or automatic downloads. **Normal accepted camera
captures still use the existing upload queue**; recording is not a dry-run mode.

## Bounds and interpretation

- The first reached limit stops recording: 15 seconds, 16 MiB of retained RGBA,
  2 MiB of serialized event payloads, or 1,500 events. Manifest framing adds a
  small bounded overhead to export size. At 320x240 and roughly 6.7 fps, the raw
  byte limit normally stops a clip before 15 seconds. Collect multiple clips.
- The recorder copies the exact, unannotated **detector input**, up to 320px on
  its long edge. These are raw RGBA bytes after the existing full-frame canvas
  resize, not native-resolution camera originals, screenshots, or JPEG crops.
  They reproduce this detector's inputs; they are not identification evidence
  or sufficient high-resolution inputs for a later detector-resolution study.
- There are zero queued writes and no asynchronous image encoders in the
  recorder. The camera retains one detector job in flight and its existing
  best/in-flight source snapshots. A memory-only Blob snapshots input before
  the worker transfer detaches it. Worker load is unchanged when recording ends.
- Camera stop, background/pause/cancel through camera stop, manual capture,
  worker errors/timeouts, and encoding failure terminate recording. A stopped
  recording accepts no late callbacks. Failure events identify their reason.
  Camera sources not used by an active encoder are released immediately.
- Each input records frame ID, monotonic sample time, wall-clock capture time,
  native camera and retained source dimensions, resize scales, detector
  dimensions, and browser media time/presented-frame count when available.
  Timer fallback reports unavailable media metadata as null.
- Input intervals and `skipped_input` events distinguish worker-busy,
  encoding, and video-not-ready gaps from detector rejections. Browser frame
  counters additionally expose delivery gaps; the recorder does not claim to
  have observed every physical sensor frame. Inputs without a decision at a
  terminal stop are pending/cancelled, not negative detections.
- Component traces include normalized bounds, available quadrilaterals, pass
  threshold, point count, rejection stage/reason, and evaluated signals. There
  are at most 256 detailed component traces per frame; omitted components and
  all component outcomes are counted. The separate `proposals` list retains
  every proposal reaching selection, even when early-component detail is capped.
  The two 320px passes and minimum 40 component pixels bound this list to at
  most 5,120 entries per frame; the recorder's trace-byte cap still applies.
  Selection records area ranking and disjoint veto IDs without changing that
  known-flawed policy.
- Detail remains `not_evaluated` when earlier gates stop assessment. Each
  decision records detector time, worker round-trip time, recording cost,
  tracker reset reason, best/capture frame ID, and actual feedback. Capture
  started/delivered/rejected events refer to the frozen source ID, which may
  precede the current frame. Fingerprint arrays and image bytes are excluded
  from numeric traces. Guidance/selection repairs remain D04/D05 work.

## Export format and inspection

`capture-trace.json` is the versioned numeric manifest. `capture-frames.vhc`
contains a four-byte little-endian unsigned JSON length, that many UTF-8
manifest bytes, then consecutive RGBA frames. `rawFrames` contains each frame's
ID, width, height, byte length, and offset relative to the raw-data section.
Match each ID to the `input` and `decision` events; geometry is normalized to
the full input frame. Detector/config versions are in the manifest.

To inspect the unannotated frames, run:

```powershell
node scripts/capture/inspect-recording.mjs C:\private\capture-frames.vhc C:\private\trial-01
```

The output directory must be new, its parent must exist, and it must be outside
the checkout. The command validates dimensions, offsets, byte counts, IDs, and
format before creating a manifest plus lossless PNGs. It uses the existing web
workspace's Sharp dependency. Keep the original `.vhc` for exact-byte replay.
Do not commit exports, PNGs, or private labels.

## Experiment and verification

| Field          | Evidence                                                                                                                                                                                                                                                             |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hypothesis     | Observing existing frame decisions makes failed capture reproducible without changing detector/tracker decisions.                                                                                                                                                    |
| Baseline       | `754b40eb2932e5d5d2cbf1c4b4dfc0b7eb02506c`; candidate is the D01 working-tree changes.                                                                                                                                                                               |
| Configuration  | `geometry-rgb-v1`, `320px-150ms-hold600-v1`; existing thresholds and source/crop policy.                                                                                                                                                                             |
| Dataset        | Generated 320x240 textured rectangle plus synthetic unit fixtures; no private corpus or physical-camera labels available.                                                                                                                                            |
| Browser        | Headless Chromium 151.0.7922.34 on Windows, Node 22.23.2.                                                                                                                                                                                                            |
| Browser result | One automatic photo, five input/decision pairs, matching visible capture feedback, exported best-frame ID present, all exported frames reproduce their original detection reason. Recording stopped on camera stop; 1,536,000 raw bytes, no drops, no queued writes. |
| Timing         | 30 warmups; 100 interleaved samples per mode: off p50/p95 18.8/23.9 ms, trace 19.4/24.4 ms, raw+trace 20.0/23.9 ms.                                                                                                                                                  |
| Timing limits  | Same synthetic browser-thread detector/input-recording workload; medians increased 0.6 ms and 1.2 ms. This is not physical-device latency, worker-message overhead, full-session memory, or a release gate.                                                          |
| Policy checks  | Diagnostics-on/off detection equality for empty, cover, document, clipped, and person fixtures; unknown detail preserved; raw transfer/export alignment; byte/time/event caps; manual/stop/failure cleanup; best-frame capture lineage.                              |
| Decision       | Keep instrumentation. No measured improvement in real capture count or artist/title accuracy is claimed.                                                                                                                                                             |
| Next           | D02 consented webcam clips and maintainer-verified labels; then measured selection/guidance repairs in task order.                                                                                                                                                   |

Run the synthetic browser check without backend services or AI calls:

The final browser rerun also recorded a clipped rectangle: zero captures,
matching clipped guidance, a raw-frame ID linked to the framing rejection, and
detail explicitly not evaluated. Its off/trace/raw p50 values were
18.1/18.4/18.9 ms and p95 values were 20.6/20.2/22.6 ms, illustrating run-to-run
variation. The extractor separately passed PNG output, existing-directory
refusal, in-repository output refusal, and truncated-data refusal checks.

Repository validation: `npm run check` and `npm run build` passed. On this
Windows checkout, generated WSL workspace links and the missing native Next
compiler had to be repaired before those commands could complete.

```bash
node scripts/capture/verify-diagnostics.mjs
```

It uses the installed Playwright Chromium and esbuild from the existing npm
toolchain, serves generated frames only on loopback, exercises the real camera
controller and worker, checks exported replay alignment, and prints numeric
timings. It retains no recording. The standard `npm run check` includes the
unit coverage; run `npm run build` for application validation.

Physical webcam, iPhone, Android, background clutter, identification accuracy,
the development-user database preflight, and D02's corpus remain pending.
Do not use the supplied UI screen recordings as raw detector inputs.
