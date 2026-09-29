import {
  project,
  type Corners,
  type Detection,
  type DetectorResult,
} from "./cover-detector";
import { CoverTracker, type CapturePhase } from "./cover-tracker";

export type CameraFeedback = {
  phase: CapturePhase;
  corners: Corners | null;
  reason: Detection["reason"];
};
export type CameraPhoto = { file: File; preview: Blob; cropped: boolean };

/** Owns at most two source snapshots (best and in-flight) and one worker job. */
export class CoverCamera {
  private worker: Worker | null = null;
  private tracker = new CoverTracker();
  private frames = new Map<number, HTMLCanvasElement>();
  private sample = document.createElement("canvas");
  private stopped = false;
  private busy = false;
  private encoding = false;
  private sequence = 0;
  private callback: number | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private deadline: ReturnType<typeof setTimeout> | null = null;
  private lastSample = -Infinity;

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
    this.worker.onerror = () => this.fail();
    this.schedule();
  }

  stop() {
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
    const source = freezeFrame(this.video);
    if (!source) return;
    this.releaseFrames();
    await this.capture(source, null);
  }

  private schedule() {
    if (this.stopped) return;
    const tick = (time: number) => {
      if (this.stopped) return;
      if (time - this.lastSample >= 150 && !this.busy && !this.encoding) {
        this.lastSample = time;
        this.inspect(time);
      }
      this.schedule();
    };
    if (typeof this.video.requestVideoFrameCallback === "function") {
      this.callback = this.video.requestVideoFrameCallback(tick);
    } else {
      this.timer = setTimeout(() => tick(performance.now()), 150);
    }
  }

  private inspect(time: number) {
    if (!this.worker) return;
    const source = freezeFrame(this.video);
    if (!source) return;
    const scale = Math.min(1, 320 / Math.max(source.width, source.height));
    this.sample.width = Math.round(source.width * scale);
    this.sample.height = Math.round(source.height * scale);
    const context = this.sample.getContext("2d", { willReadFrequently: true });
    if (!context) {
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
      this.frames.set(id, source);
      this.busy = true;
      this.deadline = setTimeout(() => this.fail(), 5_000);
      this.worker.postMessage(
        {
          id,
          time,
          width: this.sample.width,
          height: this.sample.height,
          pixels,
        },
        [pixels.buffer],
      );
    } catch {
      this.fail();
    }
  }

  private receive(data: DetectorResult) {
    if (this.stopped) return;
    this.busy = false;
    if (this.deadline) clearTimeout(this.deadline);
    // Manual capture can supersede an in-flight detection. Its snapshot no
    // longer exists, so a late result cannot alter the new presentation.
    if (!this.frames.has(data.id) || this.encoding) return;
    const update = this.tracker.inspect(data.id, data.time, data);
    this.feedback({
      phase: update.phase,
      corners: data.candidate?.corners ?? null,
      reason: data.reason,
    });
    if (update.capture) {
      const source = this.frames.get(update.capture.id);
      if (source)
        void this.capture(
          source,
          update.capture.candidate.corners,
          update.capture.candidate,
        );
      this.releaseFrames();
    } else {
      this.releaseFrames(update.best?.id);
    }
  }

  private async capture(
    source: HTMLCanvasElement,
    corners: Corners | null,
    candidate: Detection["candidate"] = null,
  ) {
    if (!this.admit(source.width * source.height * 4)) {
      source.width = source.height = 0;
      return;
    }
    this.encoding = true;
    this.feedback({ phase: "capturing", corners, reason: "ready" });
    try {
      // Freeze and encode from the selected source, never a newer video frame.
      const crop = corners ? renderCrop(source, corners) : null;
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
      });
      this.tracker.capturedFrame(candidate);
      this.feedback({ phase: "waiting", corners, reason: "ready" });
    } catch {
      if (!this.stopped) this.fail();
    } finally {
      source.width = source.height = 0;
      this.encoding = false;
    }
  }

  private releaseFrames(keep?: number) {
    for (const [id, source] of this.frames) {
      if (id === keep) continue;
      // A selected source is being encoded; the encoder retains it until done.
      if (!this.encoding) source.width = source.height = 0;
      this.frames.delete(id);
    }
  }

  private fail() {
    if (this.stopped) return;
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

/** Local preview only: the original remains the uploaded analysis input. */
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
