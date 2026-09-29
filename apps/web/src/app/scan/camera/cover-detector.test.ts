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
  it.each(["gradient", "noise"] as const)(
    "keeps %s backgrounds out of automatic capture",
    (kind) => {
      const frame = scene("empty");
      let seed = 17;
      for (let y = 0; y < frame.height; y++)
        for (let x = 0; x < frame.width; x++) {
          seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
          const value = kind === "gradient" ? 30 + x / 2 : 100 + (seed % 30);
          for (let c = 0; c < 3; c++)
            frame.pixels[(y * frame.width + x) * 4 + c] = value;
        }
      expect(detectCover(frame).candidate).toBeNull();
    },
  );
  function rectangle(
    bounds: [number, number, number, number],
    background: [number, number, number] = [15, 15, 15],
    color: [number, number, number] = [150, 150, 150],
    texture = 6,
  ) {
    const frame = scene("empty");
    const [left, top, right, bottom] = bounds;
    for (let y = 0; y < frame.height; y++)
      for (let x = 0; x < frame.width; x++) {
        const inside = x >= left && x <= right && y >= top && y <= bottom;
        const noise = inside && texture ? (x * 13 + y * 7) % texture : 0;
        for (let c = 0; c < 3; c++)
          frame.pixels[(y * frame.width + x) * 4 + c] =
            (inside ? color[c] : background[c]) + noise;
      }
    return frame;
  }

  it("uses color boundaries between surfaces with similar luminance", () => {
    const result = detectCover(
      rectangle([80, 40, 240, 200], [60, 121, 60], [180, 60, 60]),
    );
    expect(result.reason).toBe("ready");
    expect(result.candidate?.corners[0].x).toBeCloseTo(0.25, 1);
    expect(result.checks).toEqual({
      boundary: true,
      framing: true,
      detail: true,
    });
  });

  it("finds a low-contrast outer edge with the adaptive pass", () => {
    const result = detectCover(
      rectangle([80, 40, 240, 200], [100, 100, 100], [112, 112, 112]),
    );
    expect(result.reason).toBe("ready");
    expect(result.signals?.edgeSupport).toBeGreaterThanOrEqual(0.65);
    expect(result.candidate?.corners[0].y).toBeCloseTo(40 / 240, 1);
  });

  it("gives distance feedback without accepting a small cover", () => {
    const result = detectCover(rectangle([130, 90, 190, 150]));
    expect(result.reason).toBe("too_small");
    expect(result.candidate).toBeNull();
    expect(result.checks?.framing).toBe(false);
    expect(result.outline).toHaveLength(4);
  });

  it("asks for a centered cover even when all edges are visible", () => {
    const result = detectCover(rectangle([5, 50, 111, 156]));
    expect(result.reason).toBe("off_center");
    expect(result.candidate).toBeNull();
  });

  it("blocks a plausible inner crop when the larger sleeve is clipped", () => {
    const frame = rectangle([0, 15, 210, 225], [15, 15, 15], [220, 190, 30], 0);
    for (let y = 60; y < 185; y++)
      for (let x = 40; x < 165; x++)
        for (let c = 0; c < 3; c++)
          frame.pixels[(y * frame.width + x) * 4 + c] =
            80 + ((x * 13 + y * 7) % 50);
    const result = detectCover(frame);
    expect(result.reason).toBe("clipped");
    expect(result.candidate).toBeNull();
    expect(result.outline?.[0].x).toBeLessThan(0.02);
  });

  it("does not confuse a bright or dark cover with poor lighting when detail is present", () => {
    expect(
      detectCover(
        rectangle([80, 40, 240, 200], [100, 100, 100], [230, 230, 230]),
      ).reason,
    ).toBe("ready");
    expect(
      detectCover(rectangle([80, 40, 240, 200], [100, 100, 100], [20, 20, 20]))
        .reason,
    ).toBe("ready");
  });

  it("asks for focus or manual recovery when a clear boundary has no usable detail", () => {
    const result = detectCover(
      rectangle([80, 40, 240, 200], [15, 15, 15], [200, 200, 200], 0),
    );
    expect(result.reason).toBe("blurry");
    expect(result.checks).toEqual({
      boundary: true,
      framing: true,
      detail: false,
    });
  });

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
