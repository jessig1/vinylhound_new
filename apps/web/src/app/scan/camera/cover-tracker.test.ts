import { describe, expect, it } from "vitest";
import type { CoverCandidate, Detection } from "./cover-detector";
import { CoverTracker } from "./cover-tracker";

function candidate(quality = 10, artwork = 0, shift = 0): CoverCandidate {
  return {
    corners: [
      { x: 0.2 + shift, y: 0.2 },
      { x: 0.8 + shift, y: 0.2 },
      { x: 0.8 + shift, y: 0.8 },
      { x: 0.2 + shift, y: 0.8 },
    ],
    fingerprint: [artwork, -artwork, artwork, -artwork],
    quality,
  };
}
const detected = (value = candidate()): Detection => ({
  candidate: value,
  reason: "ready",
});
const absent: Detection = { candidate: null, reason: "searching" };
function hold(tracker: CoverTracker, start = 0, value = candidate()) {
  let result = tracker.inspect(start, start, detected(value));
  for (let offset = 150; offset <= 600; offset += 150)
    result = tracker.inspect(start + offset, start + offset, detected(value));
  return result;
}

describe("cover presentation tracking", () => {
  it("reports steady-hold progress and resets it when the cover moves", () => {
    const tracker = new CoverTracker();
    tracker.inspect(1, 0, detected());
    expect(tracker.inspect(2, 300, detected()).progress).toBe(0.5);
    const moved = tracker.inspect(3, 450, detected(candidate(10, 0, 0.1)));
    expect(moved.progress).toBe(0);
    expect(moved.moving).toBe(true);
    expect(moved.capture).toBeNull();
  });
  it.each([
    "clipped",
    "too_small",
    "weak_boundary",
    "blurry",
    "low_light",
  ] as const)(
    "does not capture or rearm from sustained %s evidence",
    (reason) => {
      const tracker = new CoverTracker();
      const detection: Detection = { candidate: candidate(), reason };
      for (let time = 0; time < 2000; time += 150)
        expect(tracker.inspect(time, time, detection).capture).toBeNull();
      tracker.capturedFrame(candidate());
      for (let time = 2000; time < 4000; time += 150)
        expect(
          tracker.inspect(time, time, { candidate: null, reason }).phase,
        ).toBe("waiting");
    },
  );
  it("never captures a still absent scene, even after a long wait", () => {
    const tracker = new CoverTracker();
    for (let time = 0; time < 60_000; time += 150)
      expect(tracker.inspect(time, time, absent).capture).toBeNull();
  });
  it("selects the clearest frozen frame, with its matching boundaries", () => {
    const tracker = new CoverTracker();
    tracker.inspect(1, 0, detected());
    const best = candidate(30);
    tracker.inspect(2, 150, detected(best));
    tracker.inspect(3, 300, detected());
    tracker.inspect(4, 450, detected());
    expect(tracker.inspect(5, 600, detected()).capture).toEqual({
      id: 2,
      candidate: best,
    });
  });
  it("does not let a moving candidate inherit the stability window", () => {
    const tracker = new CoverTracker();
    tracker.inspect(1, 0, detected());
    tracker.inspect(2, 150, detected());
    tracker.inspect(3, 300, detected(candidate(10, 0, 0.1)));
    expect(
      tracker.inspect(4, 600, detected(candidate(10, 0, 0.1))).capture,
    ).toBeNull();
  });
  it("tolerates one dropped detection but resets after sustained loss", () => {
    const tracker = new CoverTracker();
    tracker.inspect(1, 0, detected());
    tracker.inspect(2, 150, detected());
    tracker.inspect(3, 300, absent);
    tracker.inspect(4, 450, detected());
    expect(tracker.inspect(5, 600, detected()).capture).not.toBeNull();
    tracker.reset();
    tracker.inspect(1, 0, detected());
    expect(tracker.inspect(2, 400, absent).phase).toBe("searching");
  });
  it("suppresses a held cover despite mild movement, then permits genuine reintroduction", () => {
    const tracker = new CoverTracker();
    hold(tracker);
    tracker.capturedFrame(candidate());
    for (let time = 750; time < 10_000; time += 150)
      expect(
        tracker.inspect(time, time, detected(candidate(20, 0, 0.01))).capture,
      ).toBeNull();
    tracker.inspect(100, 10_000, absent);
    expect(tracker.inspect(101, 10_200, absent).phase).toBe("waiting");
    expect(tracker.inspect(102, 10_400, absent).phase).toBe("searching");
    expect(hold(tracker, 10_600).capture).not.toBeNull();
  });
  it("captures a stable direct replacement without an empty interval", () => {
    const tracker = new CoverTracker();
    hold(tracker);
    tracker.capturedFrame(candidate());
    const replacement = candidate(10, 1);
    tracker.inspect(6, 750, detected(replacement));
    tracker.inspect(7, 900, detected(replacement));
    tracker.inspect(8, 1050, detected(replacement));
    tracker.inspect(9, 1200, detected(replacement));
    tracker.inspect(10, 1350, detected(replacement));
    tracker.inspect(11, 1500, detected(replacement));
    tracker.inspect(12, 1650, detected(replacement));
    expect(
      tracker.inspect(13, 1800, detected(replacement)).capture,
    ).not.toBeNull();
  });
  it("does not treat ambiguous targets as proof of removal", () => {
    const tracker = new CoverTracker();
    tracker.capturedFrame(candidate());
    tracker.inspect(1, 0, { candidate: null, reason: "multiple" });
    expect(
      tracker.inspect(2, 1000, { candidate: null, reason: "multiple" }).phase,
    ).toBe("waiting");
  });
});
