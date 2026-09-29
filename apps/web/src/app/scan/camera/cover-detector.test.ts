import { describe, expect, it } from "vitest";
import {
  detectCover,
  project,
  type Corners,
  type DetectorFrame,
} from "./cover-detector";

function scene(kind: "empty" | "cover" | "document" | "clipped" | "person") {
  const width = 320,
    height = 240;
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const cover =
        kind === "cover" && x >= 80 && x <= 240 && y >= 40 && y <= 200;
      const document =
        kind === "document" && x >= 100 && x <= 220 && y >= 20 && y <= 220;
      const clipped =
        kind === "clipped" && x >= 0 && x <= 150 && y >= 40 && y <= 190;
      const person =
        kind === "person" &&
        ((x - 160) / 75) ** 2 + ((y - 120) / 100) ** 2 <= 1;
      const value =
        cover || document || clipped || person
          ? 150 + ((x * 13 + y * 7) % 50)
          : 15;
      const i = (y * width + x) * 4;
      pixels[i] = pixels[i + 1] = pixels[i + 2] = value;
      pixels[i + 3] = 255;
    }
  return { id: 1, time: 0, width, height, pixels } satisfies DetectorFrame;
}

describe("experimental cover geometry", () => {
  it.each(["empty", "document", "clipped", "person"] as const)(
    "does not trigger on a %s scene",
    (kind) => {
      expect(detectCover(scene(kind)).candidate).toBeNull();
    },
  );
  it("finds a complete cover and returns source-normalized boundaries", () => {
    const result = detectCover(scene("cover"));
    expect(result.reason).toBe("ready");
    expect(result.candidate?.corners[0].x).toBeCloseTo(80 / 320, 1);
    expect(result.candidate?.corners[0].y).toBeCloseTo(40 / 240, 1);
    expect(result.candidate?.fingerprint).toHaveLength(256);
  });
  it("rejects unbounded input before allocating detector buffers", () => {
    expect(() => detectCover({ ...scene("empty"), width: 1920 })).toThrow(
      "Invalid detector frame",
    );
  });
  it("detects a tilted square without requiring screen-aligned corners", () => {
    const frame = scene("empty");
    for (let y = 0; y < frame.height; y++)
      for (let x = 0; x < frame.width; x++) {
        if (Math.abs(x - 160) + Math.abs(y - 120) <= 85) {
          const i = (y * frame.width + x) * 4;
          frame.pixels[i] =
            frame.pixels[i + 1] =
            frame.pixels[i + 2] =
              150 + ((x * 13 + y * 7) % 50);
        }
      }
    expect(detectCover(frame).reason).toBe("ready");
  });
  it("asks for one target instead of accepting two distinct covers", () => {
    const frame = scene("empty");
    for (let y = 60; y <= 170; y++)
      for (let x = 20; x <= 300; x++) {
        if (x <= 130 || x >= 190) {
          const i = (y * frame.width + x) * 4;
          frame.pixels[i] =
            frame.pixels[i + 1] =
            frame.pixels[i + 2] =
              150 + ((x * 13 + y * 7) % 50);
        }
      }
    expect(detectCover(frame)).toEqual({ candidate: null, reason: "multiple" });
  });
  it("maps the crop corners and center for a tilted perspective", () => {
    const corners: Corners = [
      { x: 0.15, y: 0.2 },
      { x: 0.8, y: 0.1 },
      { x: 0.9, y: 0.85 },
      { x: 0.1, y: 0.8 },
    ];
    for (const [i, uv] of [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ].entries()) {
      const p = project(corners, uv[0], uv[1]);
      expect(p.x).toBeCloseTo(corners[i].x);
      expect(p.y).toBeCloseTo(corners[i].y);
    }
    const p = project(corners, 0.5, 0.5);
    expect(p.x).toBeGreaterThan(0.4);
    expect(p.x).toBeLessThan(0.6);
  });
});
