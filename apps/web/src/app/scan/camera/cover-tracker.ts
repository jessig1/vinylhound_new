import type { CoverCandidate, Detection } from "./cover-detector";

export type CapturePhase = "searching" | "qualifying" | "capturing" | "waiting";
type TrackedFrame = { id: number; candidate: CoverCandidate };
export type TrackingUpdate = {
  phase: CapturePhase;
  best: TrackedFrame | null;
  capture: TrackedFrame | null;
};

export function fingerprintDifference(a: number[], b: number[]) {
  if (a.length !== b.length || !a.length) return Infinity;
  return a.reduce((sum, n, i) => sum + Math.abs(n - b[i]), 0) / a.length;
}

function motion(a: CoverCandidate, b: CoverCandidate) {
  return Math.max(
    ...a.corners.map((p, i) =>
      Math.hypot(p.x - b.corners[i].x, p.y - b.corners[i].y),
    ),
  );
}

/** Time-based hysteresis, scoped to a presentation rather than session artwork. */
export class CoverTracker {
  private phase: CapturePhase = "searching";
  private best: TrackedFrame | null = null;
  private prior: CoverCandidate | null = null;
  private captured: CoverCandidate | null = null;
  private since = 0;
  private lastSeen = 0;
  private absentSince: number | null = null;
  private replacementSince: number | null = null;

  reset() {
    this.phase = "searching";
    this.best = this.prior = this.captured = null;
    this.absentSince = this.replacementSince = null;
  }

  capturedFrame(candidate: CoverCandidate | null) {
    this.phase = "waiting";
    this.captured = candidate;
    this.best = null;
    this.prior = null;
    this.absentSince = this.replacementSince = null;
  }

  inspect(id: number, time: number, detection: Detection): TrackingUpdate {
    const candidate = detection.candidate;
    if (this.phase === "capturing") return this.update();
    if (this.phase === "waiting") {
      if (!candidate) {
        // Competing candidates/poor quality do not prove removal.
        if (detection.reason === "searching") {
          this.absentSince ??= time;
          if (time - this.absentSince >= 350) this.reset();
        } else this.absentSince = null;
        this.replacementSince = null;
        return this.update();
      }
      this.absentSince = null;
      if (
        !this.captured ||
        fingerprintDifference(
          candidate.fingerprint,
          this.captured.fingerprint,
        ) < 0.65
      ) {
        this.replacementSince = null;
        return this.update();
      }
      this.replacementSince ??= time;
      if (time - this.replacementSince < 400) return this.update();
      this.reset();
    }
    if (!candidate || detection.reason !== "ready") {
      if (time - this.lastSeen > 300) this.reset();
      return this.update();
    }
    if (
      !this.prior ||
      time - this.lastSeen > 300 ||
      motion(candidate, this.prior) > 0.035 ||
      fingerprintDifference(candidate.fingerprint, this.prior.fingerprint) >
        0.35
    ) {
      this.since = time;
      this.best = null;
    }
    this.lastSeen = time;
    this.prior = candidate;
    this.phase = "qualifying";
    if (!this.best || candidate.quality > this.best.candidate.quality)
      this.best = { id, candidate };
    if (time - this.since >= 600) {
      this.phase = "capturing";
      return { ...this.update(), capture: this.best };
    }
    return this.update();
  }

  private update(): TrackingUpdate {
    return { phase: this.phase, best: this.best, capture: null };
  }
}
