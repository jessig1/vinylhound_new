import {
  project,
  type Corners,
  type Detection,
  type DetectorResult,
} from "./cover-detector";
import { CoverTracker, type CapturePhase } from "./cover-tracker";
import { CaptureGuidance, type GuidanceReason } from "./capture-guidance";
import type { CaptureDiagnostics } from "./capture-diagnostics";

export type CameraFeedback = {
  phase: CapturePhase;
  corners: Corners | null;
  reason: GuidanceReason;
  checks?: Detection["checks"];
  progress?: number;
};
export type CameraPhoto = {
  file: File;
  preview: Blob;
  cropped: boolean;
  crop?: {
    corners: Corners;
    width: number;
    height: number;
    sourceWidth: number;
    sourceHeight: number;
    capturedAt: string;
  };
};

/** Owns at most two source snapshots (best and in-flight) and one worker job. */
export class CoverCamera {
  private worker: Worker | null = null;
  private tracker = new CoverTracker();
  private guidance = new CaptureGuidance();
  private frames = new Map<
    number,
    { source: HTMLCanvasElement; capturedAt: string }
  >();
  private sample = document.createElement("canvas");
  private stopped = false;
  private busy = false;
  private encoding = false;
  private encodingSource: HTMLCanvasElement | null = null;
  private sequence = 0;
  private callback: number | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private deadline: ReturnType<typeof setTimeout> | null = null;
  private lastSample = -Infinity;
  private diagnostics: CaptureDiagnostics | null = null;
  private sentAt = 0;
  private captureFrameId: number | null = null;

  setDiagnostics(recorder: CaptureDiagnostics) {
    this.diagnostics?.stop("replaced");
    this.diagnostics = recorder;
  }

  constructor(
    private video: HTMLVideoElement,
    private feedback: (value: CameraFeedback) => void,
    private photo: (value: CameraPhoto) => void,
    private error: () => void,
    private admit: (bytes: number) => boolean,
  ) {}

  start() {
    this.worker = new Worker(
      new URL("./cover-detector.worker.ts", import.meta.url),
      { type: "module" },
    );
    this.worker.onmessage = ({ data }: MessageEvent<DetectorResult>) =>
      this.receive(data);
    this.worker.onerror = () => this.fail("worker_error");
    this.schedule();
  }

  stop() {
    this.diagnostics?.stop("camera_stop");
    this.stopped = true;
    if (this.callback !== null && this.video.cancelVideoFrameCallback)
      this.video.cancelVideoFrameCallback(this.callback);
    if (this.timer) clearTimeout(this.timer);
    if (this.deadline) clearTimeout(this.deadline);
    this.worker?.terminate();
    this.worker = null;
    this.releaseFrames();
    this.sample.width = this.sample.height = 0;
  }

  /** Explicit override also allows scanning another physical copy. */
  async manual() {
    if (this.stopped || this.encoding) return;
    this.diagnostics?.event("manual_capture", {
      supersededFrameIds: [...this.frames.keys()],
    });
    this.diagnostics?.stop("manual_capture");
    const source = freezeFrame(this.video);
    if (!source) return;
    this.releaseFrames();
    await this.capture(source, null);
  }

  private schedule() {
    if (this.stopped) return;
    const tick = (time: number, metadata?: VideoFrameCallbackMetadata) => {
      if (this.stopped) return;
      if (time - this.lastSample >= 150 && !this.busy && !this.encoding) {
        this.lastSample = time;
        this.inspect(time, metadata);
      } else if (time - this.lastSample >= 150) {
        this.diagnostics?.event("skipped_input", {
          time,
          reason: this.busy ? "worker_busy" : "capture_encoding",
        });
      }
      this.schedule();
    };
    if (typeof this.video.requestVideoFrameCallback === "function") {
      this.callback = this.video.requestVideoFrameCallback(tick);
    } else {
      this.timer = setTimeout(() => tick(performance.now()), 150);
    }
  }

  private inspect(time: number, metadata?: VideoFrameCallbackMetadata) {
    if (!this.worker) return;
    const source = freezeFrame(this.video);
    if (!source) {
      this.diagnostics?.event("skipped_input", {
        time,
        reason: "video_not_ready",
      });
      return;
    }
    const scale = Math.min(1, 320 / Math.max(source.width, source.height));
    this.sample.width = Math.round(source.width * scale);
    this.sample.height = Math.round(source.height * scale);
    const context = this.sample.getContext("2d", { willReadFrequently: true });
    if (!context) {
      source.width = source.height = 0;
      this.fail();
      return;
    }
    try {
      context.drawImage(source, 0, 0, this.sample.width, this.sample.height);
      const pixels = context.getImageData(
        0,
        0,
        this.sample.width,
        this.sample.height,
      ).data;
      const id = ++this.sequence;
      const capturedAt = new Date().toISOString();
      this.frames.set(id, { source, capturedAt });
      const diagnosticsStarted = performance.now();
      const diagnosticFrame = this.diagnostics?.active === true;
      this.diagnostics?.frame(
        {
          id,
          time,
          width: this.sample.width,
          height: this.sample.height,
          pixels,
        },
        {
          cameraWidth: this.video.videoWidth,
          cameraHeight: this.video.videoHeight,
          sourceWidth: source.width,
          sourceHeight: source.height,
          capturedAt,
          mediaTime: metadata?.mediaTime ?? null,
          presentedFrames: metadata?.presentedFrames ?? null,
        },
      );
      if (diagnosticFrame)
        this.diagnostics?.event("recording_cost", {
          id,
          ms: performance.now() - diagnosticsStarted,
        });
      this.busy = true;
      this.deadline = setTimeout(() => this.fail("worker_timeout"), 5_000);
      this.sentAt = performance.now();
      this.worker.postMessage(
        {
          id,
          time,
          width: this.sample.width,
          height: this.sample.height,
          pixels,
          ...(diagnosticFrame ? { diagnostics: true } : {}),
        },
        [pixels.buffer],
      );
    } catch {
      source.width = source.height = 0;
      this.fail();
    }
  }

  private receive(data: DetectorResult) {
    if (this.stopped) return;
    this.busy = false;
    if (this.deadline) clearTimeout(this.deadline);
    // Manual capture can supersede an in-flight detection. Its snapshot no
    // longer exists, so a late result cannot alter the new presentation.
    if (!this.frames.has(data.id) || this.encoding) {
      this.diagnostics?.event("ignored_result", {
        id: data.id,
        reason: "superseded_or_encoding",
      });
      return;
    }
    const update = this.tracker.inspect(data.id, data.time, data);
    const feedback = {
      phase: update.phase,
      corners: data.outline ?? data.candidate?.corners ?? null,
      reason: this.guidance.inspect(data.reason, update.moving, data.time),
      checks: data.checks,
      progress: data.reason === "ready" ? update.progress : 0,
    };
    this.diagnostics?.event("decision", {
      id: data.id,
      time: data.time,
      workerRoundTripMs: performance.now() - this.sentAt,
      detector: data.diagnostics ?? null,
      reason: data.reason,
      // Fingerprints are not needed to explain the UI; never export pixel-like arrays in numeric traces.
      assessment: {
        ...data.signals,
        detail:
          data.signals?.sharpness == null
            ? "not_evaluated"
            : data.checks?.detail
              ? "passed"
              : "failed",
      },
      tracker: {
        phase: update.phase,
        bestFrameId: update.best?.id ?? null,
        captureFrameId: update.capture?.id ?? null,
        resetReason: update.resetReason,
        moving: update.moving,
        progress: update.progress,
      },
      feedback,
    });
    this.feedback(feedback);
    if (update.capture) {
      const frame = this.frames.get(update.capture.id);
      if (frame) {
        this.captureFrameId = update.capture.id;
        void this.capture(
          frame.source,
          update.capture.candidate.corners,
          update.capture.candidate,
          frame.capturedAt,
        );
      }
      this.releaseFrames();
    } else {
      this.releaseFrames(update.best?.id);
    }
  }

  private async capture(
    source: HTMLCanvasElement,
    corners: Corners | null,
    candidate: Detection["candidate"] = null,
    capturedAt = new Date().toISOString(),
  ) {
    if (!this.admit(source.width * source.height * 4)) {
      this.diagnostics?.event("capture_rejected", {
        frameId: this.captureFrameId,
        reason: "admission",
      });
      source.width = source.height = 0;
      return;
    }
    this.encoding = true;
    this.encodingSource = source;
    this.diagnostics?.event("capture_started", {
      frameId: this.captureFrameId,
      path: corners ? "crop" : "source",
    });
    this.feedback({ phase: "capturing", corners, reason: "ready" });
    let crop: HTMLCanvasElement | null = null;
    try {
      // Freeze and encode from the selected source, never a newer video frame.
      crop = corners ? renderCrop(source, corners) : null;
      const [original, preview] = await Promise.all([
        encode(source),
        crop ? encode(crop) : Promise.resolve(null),
      ]);
      if (crop) crop.width = crop.height = 0;
      if (this.stopped) return;
      if (!original) throw new Error("Camera encoding failed");
      this.photo({
        file: new File([original], `live-cover-${Date.now()}.jpg`, {
          type: "image/jpeg",
        }),
        preview: preview ?? original,
        cropped: preview !== null,
        ...(preview && corners
          ? {
              crop: {
                corners,
                width: 512,
                height: 512,
                sourceWidth: source.width,
                sourceHeight: source.height,
                capturedAt,
              },
            }
          : {}),
      });
      this.tracker.capturedFrame(candidate);
      this.diagnostics?.event("capture_delivered", {
        frameId: this.captureFrameId,
      });
      this.feedback({ phase: "waiting", corners, reason: "ready" });
    } catch {
      if (!this.stopped) this.fail("encoding_error");
    } finally {
      if (crop) crop.width = crop.height = 0;
      source.width = source.height = 0;
      this.encoding = false;
      this.encodingSource = null;
    }
  }

  private releaseFrames(keep?: number) {
    for (const [id, frame] of this.frames) {
      if (id === keep) continue;
      // A selected source is being encoded; the encoder retains it until done.
      if (frame.source !== this.encodingSource)
        frame.source.width = frame.source.height = 0;
      this.frames.delete(id);
    }
  }

  private fail(reason = "camera_error") {
    if (this.stopped) return;
    this.diagnostics?.event("worker_or_camera_failure", {
      frameIds: [...this.frames.keys()],
      reason,
    });
    this.diagnostics?.stop("worker_or_camera_failure");
    this.stop();
    this.error();
  }
}

export function freezeFrame(video: HTMLVideoElement) {
  if (video.readyState < 2 || !video.videoWidth || !video.videoHeight)
    return null;
  const canvas = document.createElement("canvas");
  const scale = Math.min(
    1,
    1600 / Math.max(video.videoWidth, video.videoHeight),
  );
  canvas.width = Math.round(video.videoWidth * scale);
  canvas.height = Math.round(video.videoHeight * scale);
  const context = canvas.getContext("2d");
  if (!context) return null;
  context.drawImage(video, 0, 0, canvas.width, canvas.height);
  return canvas;
}

export function encode(canvas: HTMLCanvasElement) {
  return new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, "image/jpeg", 0.9),
  );
}

/** This exact preview is uploaded as the linked analysis crop (ADR-0033). */
function renderCrop(source: HTMLCanvasElement, corners: Corners) {
  const result = document.createElement("canvas");
  result.width = result.height = 512;
  const input = source
    .getContext("2d")
    ?.getImageData(0, 0, source.width, source.height);
  const context = result.getContext("2d");
  if (!input || !context) throw new Error("Crop preview unavailable");
  const output = context.createImageData(512, 512);
  for (let y = 0; y < 512; y++)
    for (let x = 0; x < 512; x++) {
      const p = project(corners, x / 511, y / 511);
      const sx = Math.max(
        0,
        Math.min(source.width - 1, Math.round(p.x * source.width)),
      );
      const sy = Math.max(
        0,
        Math.min(source.height - 1, Math.round(p.y * source.height)),
      );
      const from = (sy * source.width + sx) * 4,
        to = (y * 512 + x) * 4;
      output.data.set(input.data.subarray(from, from + 4), to);
    }
  context.putImageData(output, 0, 0);
  return result;
}
