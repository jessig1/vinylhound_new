import sharp from "sharp";
import { describe, expect, it } from "vitest";

import { normalizeImage } from "./image-normalization.js";

async function createPng(width: number, height: number) {
  return sharp({
    create: { width, height, channels: 3, background: "#4f3727" },
  })
    .png()
    .toBuffer();
}

describe("normalizeImage", () => {
  it("downsizes a large image to bounded analysis and thumbnail copies", async () => {
    const bytes = await createPng(4000, 3000);

    const { analysis, thumbnail } = await normalizeImage(bytes);

    expect(analysis.mimeType).toBe("image/jpeg");
    expect(analysis.width).toBeLessThanOrEqual(2048);
    expect(analysis.height).toBeLessThanOrEqual(2048);
    expect(analysis.sizeBytes).toBeLessThan(bytes.byteLength);

    expect(thumbnail.mimeType).toBe("image/jpeg");
    expect(thumbnail.width).toBeLessThanOrEqual(400);
    expect(thumbnail.height).toBeLessThanOrEqual(400);
    expect(thumbnail.sizeBytes).toBeLessThan(analysis.sizeBytes);
  });

  it("does not enlarge an image already smaller than the target bounds", async () => {
    const bytes = await createPng(120, 90);

    const { analysis } = await normalizeImage(bytes);

    expect(analysis.width).toBe(120);
    expect(analysis.height).toBe(90);
  });
});
