import type { DetectorFrame } from "./cover-detector";
import {
  CAPTURE_CONFIG_VERSION,
  DETECTOR_VERSION,
} from "./detector-diagnostics";

export const DIAGNOSTIC_LIMITS = {
  durationMs: 15_000,
  rawBytes: 16 * 1024 * 1024,
  traceBytes: 2 * 1024 * 1024,
  events: 1500,
} as const;

type RawFrame = {
  id: number;
  offset: number;
  length: number;
  width: number;
  height: number;
};
export type FrameSource = {
  cameraWidth: number;
  cameraHeight: number;
  sourceWidth: number;
  sourceHeight: number;
  capturedAt: string;
  mediaTime: number | null;
  presentedFrames: number | null;
};

/** Private, memory-only recorder. No network, storage, image encoding or write queue. */
export class CaptureDiagnostics {
  private lines: string[] = [];
  private chunks: Blob[] = [];
  private rawFrames: RawFrame[] = [];
  private traceBytes = 0;
  private rawBytes = 0;
  private droppedEvents = 0;
  private droppedRawFrames = 0;
  private lastFrameTime: number | null = null;
  private timer: ReturnType<typeof setTimeout> | null;
  private stoppedAt: number | null = null;
  private stopReason: string | null = null;
  private started = performance.now();
  readonly startedAt = new Date().toISOString();
  latestDecision = "";

  constructor(
    readonly rawEnabled: boolean,
    readonly appRevision: string,
    private limits: {
      durationMs: number;
      rawBytes: number;
      traceBytes: number;
      events: number;
    } = DIAGNOSTIC_LIMITS,
  ) {
    this.timer = setTimeout(
      () => this.stop("duration_limit"),
      limits.durationMs,
    );
  }

  get active() {
    return this.stoppedAt === null;
  }

  event(type: string, payload: unknown) {
    if (!this.active) return false;
    if (performance.now() - this.started >= this.limits.durationMs) {
      this.stop("duration_limit");
      return false;
    }
    const line = JSON.stringify({
      type,
      atMs: performance.now() - this.started,
      payload,
    });
    const bytes = new TextEncoder().encode(line).byteLength;
    if (
      this.lines.length >= this.limits.events ||
      this.traceBytes + bytes > this.limits.traceBytes
    ) {
      this.droppedEvents++;
      this.stop("trace_limit");
      return false;
    }
    this.lines.push(line);
    this.traceBytes += bytes;
    if (type === "decision") this.latestDecision = line;
    return true;
  }

  frame(frame: DetectorFrame, source: FrameSource) {
    if (!this.active) return;
    if (performance.now() - this.started >= this.limits.durationMs) {
      this.stop("duration_limit");
      return;
    }
    let raw: "disabled" | "retained" | "byte_limit" = "disabled";
    if (this.rawEnabled) {
      if (this.rawBytes + frame.pixels.byteLength > this.limits.rawBytes) {
        raw = "byte_limit";
        this.droppedRawFrames++;
      } else {
        // Blob snapshots the bytes before postMessage transfers/detaches them.
        const blob = new Blob([
          new Uint8Array(
            frame.pixels.buffer as ArrayBuffer,
            frame.pixels.byteOffset,
            frame.pixels.byteLength,
          ),
        ]);
        this.rawFrames.push({
          id: frame.id,
          offset: this.rawBytes,
          length: blob.size,
          width: frame.width,
          height: frame.height,
        });
        this.chunks.push(blob);
        this.rawBytes += blob.size;
        raw = "retained";
      }
    }
    const recorded = this.event("input", {
      id: frame.id,
      time: frame.time,
      width: frame.width,
      height: frame.height,
      ...source,
      raw,
      intervalMs:
        this.lastFrameTime === null ? null : frame.time - this.lastFrameTime,
      transform: {
        operation: "full-frame-resize",
        crop: null,
        mirrored: false,
        sourceToDetectorX: frame.width / source.sourceWidth,
        sourceToDetectorY: frame.height / source.sourceHeight,
        cameraToSourceX: source.sourceWidth / source.cameraWidth,
        cameraToSourceY: source.sourceHeight / source.cameraHeight,
        pixels: "rgba8",
        smoothing: "canvas-default",
      },
    });
    // Never export a frame whose timing/transform metadata could not be retained.
    if (!recorded && raw === "retained") {
      this.chunks.pop();
      this.rawFrames.pop();
      this.rawBytes -= frame.pixels.byteLength;
      this.droppedRawFrames++;
    }
    this.lastFrameTime = frame.time;
    if (raw === "byte_limit") this.stop("raw_byte_limit");
  }

  stop(reason: string) {
    if (!this.active) return;
    this.stoppedAt = performance.now();
    this.stopReason = reason;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  summary() {
    return {
      active: this.active,
      reason: this.stopReason,
      durationMs: (this.stoppedAt ?? performance.now()) - this.started,
      events: this.lines.length,
      traceBytes: this.traceBytes,
      rawBytes: this.rawBytes,
      rawFrames: this.rawFrames.length,
      droppedEvents: this.droppedEvents,
      droppedRawFrames: this.droppedRawFrames,
      queuedWrites: 0,
    };
  }

  manifest() {
    return {
      format: "vinylhound-capture-diagnostics-v1",
      appRevision: this.appRevision,
      appRevisionSource: "operator-entered",
      detectorVersion: DETECTOR_VERSION,
      configVersion: CAPTURE_CONFIG_VERSION,
      startedAt: this.startedAt,
      limits: this.limits,
      summary: this.summary(),
      rawEnabled: this.rawEnabled,
      rawFrames: this.rawFrames,
      events: this.lines.map((line) => JSON.parse(line) as unknown),
    };
  }

  traceBlob() {
    this.stop("export");
    return new Blob([JSON.stringify(this.manifest())], {
      type: "application/json",
    });
  }

  rawBlob() {
    this.stop("export");
    // Little-endian uint32 JSON byte length, UTF-8 manifest, contiguous RGBA.
    const metadata = new TextEncoder().encode(JSON.stringify(this.manifest()));
    const header = new ArrayBuffer(4);
    new DataView(header).setUint32(0, metadata.byteLength, true);
    return new Blob([header, metadata, ...this.chunks], {
      type: "application/octet-stream",
    });
  }

  discard() {
    this.stop("discard");
    this.lines = [];
    this.chunks = [];
    this.rawFrames = [];
    this.traceBytes = this.rawBytes = 0;
    this.latestDecision = "";
  }
}
