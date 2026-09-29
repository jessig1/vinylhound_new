import type { Detection } from "./cover-detector";

export type GuidanceReason = Detection["reason"] | "moving" | "searching_help";

export function captureGuidance(reason: GuidanceReason): string {
  switch (reason) {
    case "too_small":
      return "Move closer so the cover fills more of the frame.";
    case "clipped":
      return "Move back until all four corners of the cover are visible.";
    case "off_center":
      return "Move the cover toward the center of the frame.";
    case "tilted":
      return "Face the cover toward the camera so all four edges are clear.";
    case "weak_boundary":
      return "Keep fingers off the edges and try a contrasting background.";
    case "low_light":
      return "Try brighter, even lighting on the cover.";
    case "multiple":
      return "Show one cover at a time.";
    case "blurry":
      return "Keep the cover steady and let the camera focus. If detail stays unclear, capture manually.";
    case "moving":
      return "Hold the cover and camera steady.";
    case "ready":
      return "Cover edges found. Hold steady for automatic capture.";
    case "searching_help":
      return "Show the whole cover against a contrasting background. Tilt slightly to avoid reflections, or capture manually.";
    case "searching":
      return "Show one front cover with all four corners visible.";
  }
}

/** Keep brief noisy frames from rapidly changing the instruction or live region. */
export class CaptureGuidance {
  private shown: GuidanceReason = "searching";
  private pending: GuidanceReason = "searching";
  private since = 0;
  private searchingSince: number | null = null;

  inspect(
    reason: Detection["reason"],
    moving: boolean,
    time: number,
  ): GuidanceReason {
    if (reason === "searching") this.searchingSince ??= time;
    else this.searchingSince = null;
    const next: GuidanceReason = moving
      ? "moving"
      : this.searchingSince !== null && time - this.searchingSince >= 3_000
        ? "searching_help"
        : reason;
    if (next !== this.pending) {
      this.pending = next;
      this.since = time;
    }
    if (time - this.since >= 450) this.shown = next;
    return this.shown;
  }
}
