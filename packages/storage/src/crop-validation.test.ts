import { describe, expect, it } from "vitest";
import type { CropProvenance } from "@vinylhound/contracts";
import { validateCropGeometry } from "./crop-validation.ts";

const crop: CropProvenance = {
  mimeType: "image/jpeg",
  sizeBytes: 1000,
  checksumSha256: "a".repeat(64),
  width: 512,
  height: 512,
  sourceWidth: 1600,
  sourceHeight: 1200,
  corners: [
    { x: 0.2, y: 0.1 },
    { x: 0.8, y: 0.1 },
    { x: 0.8, y: 0.9 },
    { x: 0.2, y: 0.9 },
  ],
  transformVersion: "perspective-nearest-v1",
  capturedAt: "2026-09-29T15:00:00.000Z",
};

describe("crop provenance geometry", () => {
  it("accepts a bounded source-space jacket boundary", () => {
    expect(() =>
      validateCropGeometry(crop, { width: 1600, height: 1200 }),
    ).not.toThrow();
  });

  it("rejects a crop paired with a different source or crossed corners", () => {
    expect(() =>
      validateCropGeometry(crop, { width: 1200, height: 1600 }),
    ).toThrow(/source dimensions/);
    expect(() =>
      validateCropGeometry(
        {
          ...crop,
          corners: [
            crop.corners[0],
            crop.corners[2],
            crop.corners[1],
            crop.corners[3],
          ],
        },
        { width: 1600, height: 1200 },
      ),
    ).toThrow(/quadrilateral/);
  });

  it("rejects a tiny inner-artwork boundary", () => {
    expect(() =>
      validateCropGeometry(
        {
          ...crop,
          corners: [
            { x: 0.4, y: 0.4 },
            { x: 0.6, y: 0.4 },
            { x: 0.6, y: 0.6 },
            { x: 0.4, y: 0.6 },
          ],
        },
        { width: 1600, height: 1200 },
      ),
    ).toThrow(/quadrilateral/);
  });
});
