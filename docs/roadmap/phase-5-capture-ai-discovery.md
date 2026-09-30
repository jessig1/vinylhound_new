# Phase 5 — Capture reliability and measured discovery

_Part of the [delivery roadmap](../ROADMAP.md). Planned 2026-09-25._

Phase 4 closed at P4.4. This phase leads with reliable hands-free scanning,
then builds collection-aware discovery from measured evidence. The former
P4.5 private data and AI baseline moves here unfinished. Phase 2 issues
#11-#15 and P3.4 Task 4 (issue #20) remain separate open work.

## Sequence

P5.1 and P5.2 were swapped on 2026-09-28: build the hands-free capture
workflow first, then complete the feasibility and baseline milestone.
P5.1's public rollout still requires P5.2's device/detector evidence and
P5.3's private AI baseline; the reordered work does not waive release gates.

### P5.1 — Reliable hands-free capture

The [album-detection iteration subplan](p5.1-album-detection-iterations.md)
breaks the failed physical trials into discrete tasks D01-D12, with conditional
D08a/D08b model experiments. Start with D01 diagnostics and D02 private replay,
then repair selection, guidance, and tracking before comparing detectors.
Each task defines dependencies, deliverables, and completion evidence. Tasks
1-3 below describe implemented infrastructure; detector reliability remains
open. Complete the subplan's evaluation before marking Task 4 passed.

- [x] **Task 1 (implementation; public rollout gated).** Replace whole-scene stillness triggering with album candidate tracking,
      quality selection, crop preview, removal/replacement rearming, and a
      bounded frame buffer. Camera start is the one session action; accepted
      albums require no shutter or submit action. Keep manual capture/file
      upload when detection is uncertain or unsupported.
      Implemented 2026-09-28 under
      [ADR-0032](../decisions/0032-experimental-cover-candidate-capture.md):
      candidate-scoped tracking, best frozen frame selection, local perspective
      preview, bounded worker/frame processing, removal/replacement rearming,
      and manual override. Automatic capture defaults off behind
      `CAPTURE_CANDIDATE_MODE_ENABLED`; its initial geometry detector is not
      a verified album classifier. Full-frame upload/analysis remains in place
      until Task 3; P5.2/P5.3's release gates are still open.
      Verification: repository checks (447 tests), workspace build, focused
      camera browser matrix (20/20), and the existing file-upload journey pass.
      A first private 81-second webcam screen recording reviewed 2026-09-29
      showed one automatic capture from three distinct sleeves presented.
      The red and sky sleeves stayed in the searching state. The yellow
      sleeve reached qualification, but the outlined candidate was its dark
      center artwork rather than the outer jacket; its lower jacket edge was
      outside the camera image. This fails the intended real-device recall and
      crop-quality outcomes. Keep the rollout gate closed and use the clip as
      P5.2 detector evidence; the recording remains outside the repository.
- [x] **Task 2.** Queue accepted items immediately with stable idempotency keys; keep the
      scanner open until explicit Finish/review. Bound local item and byte
      capacity, including encoding and in-flight uploads. Preserve quota
      pauses, retries, batch rollover, refresh recovery, and cancellation.
      Completed 2026-09-29: camera items already joined the upload queue;
      synchronized queue records and persisted their keys before batch
      creation. Admission now bounds 20 pending records and 32 MiB of retained
      photo/preview bytes plus an encoding reservation. A completed upload
      resumes submission without requiring its image after refresh; completed
      camera-session batch links also survive refresh. Quota rejections pause
      the camera and retry controls, concurrent full-batch responses share one
      rollover, and cancellation invalidates late async work and cancels a
      created scan. Browser checks cover these paths with the synthetic worker.
      Physical-device memory behavior and detector recall remain P5.2 gates.
- [x] **Task 3.** Before persistence or public-contract changes, record an ADR for source
      versus analysis crop ownership and provenance. Preserve the accepted
      source privately, link one crop used for analysis and preview, and retain
      source/crop dimensions, checksums, transform coordinates/version, and
      capture time. Update contracts and old/new fixtures before implementation;
      validate bytes and geometry server-side. Keep legacy/manual uploads and
      multi-view scans compatible, and update capture/privacy copy.
      Completed 2026-09-29 under ADR-0033. Automatic captures sign and upload
      the accepted source plus the exact JPEG crop shown in the preview.
      Completion checks source/crop bytes, dimensions, checksums, capture time,
      and convex source-space corners before deriving analysis and thumbnail
      from the crop. The linked row retains source/crop provenance; account and
      abandoned-scan cleanup include the crop object. No-crop manual, file,
      legacy, and multi-view paths continue to use the source. Frozen old
      fixtures were retained and new crop request/response fixtures added.
      `npm run check` (462 tests), `npm run build`, `npm run check:contracts`,
      database integration (83 tests), and focused mobile Chromium camera
      browser tests (7/7) passed. The contract compatibility report notes that
      an old server replica rejects the new optional crop request, so keep the
      default-off capture flag disabled through a rolling deployment. A
      geometrically valid crop can still target inner artwork; P5.2/P5.3
      evidence remains required before public rollout.
- [ ] **Task 4.** Roll out behind a feature flag with a manual fallback. Use the
      [proposal's acceptance gates](../CONTINUOUS_CAPTURE_IMPROVEMENT_PLAN.md)
      separately for supported iPhone, Android, and laptop/webcam setups:
      false captures, album and replacement recall, duplicates, crop quality,
      warm latency, memory/performance, and a ten-album session. Record counts
      and denominators, not only pooled percentages. Require a private
      full-frame versus crop identification comparison before claiming an AI
      recognition improvement.
      A [per-setup evaluation protocol and result sheet](../CAPTURE_GATE_EVALUATION.md)
      now records the required denominators and the initial failed webcam trial.
      No physical setup has passed the release gates; iPhone and Android remain
      unmeasured, and the private paired AI comparison has not run. Keep the
      public flag off and this task open.
      The 2026-09-29 layered guidance experiment adds color/luminance edge
      evidence, adaptive boundary detection, framing/detail checks, tentative
      outlines, stable recovery instructions, and hold-steady progress. Synthetic
      weak-contrast/color, small/clipped, nested-artwork, and negative scenes pass;
      a second private 4m06s webcam trial reviewed 2026-09-30 still fails.
      Six distinct sleeves appear with no successful scans reported; sampled
      frames show wall-object outlines and wrong-target move-back advice.
      See the [video review](../CAPTURE_VIDEO_REVIEW_2026-09-30.md) for
      evidence limits, the target-selection defect, and the recommended
      private replay/repair/detector comparison. No physical gate has passed.

Exit: recorded-frame and real-device tests pass the documented gates; analysis
receives the linked crop, the audit trail remains intact, and unsupported cases
have an explicit recovery path. Keep the feature flag off for setups that fail.

### P5.2 — Capture feasibility and baseline

Use the [P5.1 subplan](p5.1-album-detection-iterations.md)'s private corpus,
replay comparisons, and per-device results as evidence for these checklist
items. P5.2 owns the baseline and detector decision; record each result once
and link it here instead of running a duplicate evaluation.

- [ ] Gather consented private phone and webcam clips with album presentations,
      removal/replacement, and no-album negatives. Keep clips out of the public
      repository; split evaluation by cover, person/background, and recording
      session rather than adjacent frames.
- [ ] Measure current false captures, missed albums, duplicates, capture delay,
      and crop coverage separately from artist/title identification. Reproduce
      the existing camera browser-test failure.
- [ ] Benchmark OpenCV.js boundary detection on representative and held-out
      clips. Compare a small album-specific detector only if geometry fails the
      [capture proposal's gates](../CONTINUOUS_CAPTURE_IMPROVEMENT_PLAN.md).
      Record loading time, per-frame cost, device support, false positives,
      recall, and the decision to proceed or revise. Neither a rectangle nor
      stillness alone establishes an album.

Exit: a supported detector and its limitations are documented for phone and
webcam workflows. No detector is called production-ready solely because the
runtime works or a synthetic browser test passes.

### P5.3 — Private data and AI baseline (former P4.5)

Start dataset collection and labeling alongside P5.1. Finish the baseline
before public application usage, model/cost optimization, or a capture-related
recognition claim; P5.1's camera work need not wait for labeling, but its
public rollout must respect these gates.

- [ ] **Task 1.** Use the existing private eval runner with consented images,
      maintainer-verified labels, development/held-out separation, and
      model/prompt versions. Keep private images and unverified labels out of
      the public repository. **Tooling complete, labeling not started.**
      `npm run eval:scaffold` (added 2026-09-24,
      `packages/evals/src/scaffold.ts`) discovers images under a private image
      root and idempotently adds blank, unrunnable cases without touching
      existing cases. No private image folder or manifest exists on this
      checkout. Follow [the labeling workflow](../EVALUATION.md#building-the-manifest):
      the maintainer supplies consented photographs and verified labels, then
      `npm run eval:ai -- --dry-run` confirms readiness.
- [ ] **Task 2.** Before billable runs, fix sample composition and acceptance
      thresholds for artist/title rank-1 and top-3 accuracy, pressing evidence
      separately, review routing, schema/provider errors, latency, tokens, and
      cost. Include difficult covers and multi-view cases; report counts and
      uncertainty.
- [ ] **Task 3.** Run the capped baseline, retain reproducible private
      artifacts, and publish sanitized aggregates, failure categories, and the
      next experiment decision. Compare full-frame and cropped inputs on the
      same private albums with unchanged identification settings. Public
      repository visibility is distinct from public application usage.

Exit: the held-out baseline is reproducible and evaluated against predeclared
thresholds. Resolve failed public-usage gates before enabling public usage.
Training and fine-tuning are not assumed by this milestone.

### P5.4 — Collection-aware discovery and catalog enrichment

- [ ] Build a non-embedding suggestion prototype from a user's saved
      collection, favorites, and playlists plus permitted Spotify/MusicBrainz
      metadata. Keep provider access behind the existing catalog/discovery
      ports; record an ADR before adding a provider, changing a service
      boundary, or persisting a new shared data contract.
- [ ] Evaluate suggestions on held-out, maintainer-reviewed examples, including
      relevance, already-owned and duplicate suppression, release-concept versus
      pressing uncertainty, provider provenance, latency, and incremental cost.
      Include the consent-free metadata cases from
      [catalog evaluation](../CATALOG_EVALUATION.md).
- [ ] Expose suggestions in discovery only after the baseline passes. Show
      provenance and allow review; never overwrite confirmed collection facts
      or auto-claim a pressing. Preserve manual search and no-result behavior.

Exit: published aggregate evidence supports useful collection-aware suggestions
within the existing monthly cost target. Scan-match ranking is a separate
follow-up informed by P5.3 failure analysis.

### P5.5 — Embeddings and data-service decision

- [ ] Compare P5.4's metadata baseline with an offline embeddings retrieval
      prototype on the same held-out examples. Measure relevance improvement,
      duplicate behavior, freshness, latency, storage, and incremental provider
      and infrastructure cost. Use permitted metadata and keep private/user
      inputs under the established ownership and retention rules.
- [ ] Publish a keep/defer decision. Add production vector storage or a new
      data service only if the measured gain is meaningful, compatible with
      provider terms, and fits the $25/month planning target. Otherwise keep
      the simpler metadata approach. Any production persistence, provider, or
      service-boundary change requires an ADR and contract compatibility plan.

Exit: the decision and reproducible comparison exist. This milestone does not
precommit a vector database or a new deployed service.

## Verification and cost gates

- For capture changes, test source-to-crop traceability, ownership,
  idempotency, quota pauses, retry/cancel, rollover, refresh recovery, stale
  callbacks, and bounded memory. Run `npm run check`, `npm run build`, the
  relevant browser/device matrix, image/storage integration checks, and
  `npm run check:contracts` when contracts change.
- Keep P3.5/P4.4's $25/month planning target unless a later explicit budget
  decision changes it. Measure persistent cost before adding always-on
  infrastructure; include AI calls and staging activation in comparisons.
- Do not infer pressing identity from a cover, AI output, a catalog candidate,
  or embedding similarity. User review and the scan audit trail remain required.
