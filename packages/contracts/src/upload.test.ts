import { describe, expect, it } from "vitest";

import {
  CreateImageUploadRequestSchema,
  detectImageMimeType,
} from "./upload.ts";

describe("CreateImageUploadRequestSchema", () => {
  const upload = {
    filename: "cover.jpg",
    mimeType: "image/jpeg",
    sizeBytes: 512,
    checksumSha256: "a".repeat(64),
  } as const;

  it("preserves the single-image API by defaulting an unlabeled image to front", () => {
    expect(CreateImageUploadRequestSchema.parse(upload)).toMatchObject({
      viewType: "front",
    });
  });

  it("accepts a labeled physical-record view", () => {
    expect(
      CreateImageUploadRequestSchema.parse({ ...upload, viewType: "spine" }),
    ).toMatchObject({ viewType: "spine" });
  });

  it("accepts an audited crop while rejecting coordinates outside the source", () => {
    const crop = {
      mimeType: "image/jpeg",
      sizeBytes: 100,
      checksumSha256: "b".repeat(64),
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
    expect(
      CreateImageUploadRequestSchema.parse({ ...upload, crop }).crop,
    ).toBeDefined();
    expect(
      CreateImageUploadRequestSchema.safeParse({
        ...upload,
        crop: {
          ...crop,
          corners: [{ x: 2, y: 0.1 }, ...crop.corners.slice(1)],
        },
      }).success,
    ).toBe(false);
  });
});

function bytesFrom(...parts: (string | number[])[]): Uint8Array {
  const flattened = parts.flatMap((part) =>
    typeof part === "string"
      ? [...part].map((char) => char.charCodeAt(0))
      : part,
  );
  return Uint8Array.from(flattened);
}

describe("detectImageMimeType", () => {
  it("detects JPEG regardless of the filename the browser derived a type from", () => {
    // Regression: a JPEG saved with a .webp extension declares image/webp via
    // File.type and previously failed server validation after a full upload.
    expect(
      detectImageMimeType(bytesFrom([0xff, 0xd8, 0xff, 0xe0], "JFIF")),
    ).toEqual({ kind: "supported", mimeType: "image/jpeg" });
  });

  it("detects PNG", () => {
    expect(
      detectImageMimeType(
        bytesFrom([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], "IHDR"),
      ),
    ).toEqual({ kind: "supported", mimeType: "image/png" });
  });

  it("detects both GIF variants", () => {
    expect(detectImageMimeType(bytesFrom("GIF87a", [0x01]))).toEqual({
      kind: "supported",
      mimeType: "image/gif",
    });
    expect(detectImageMimeType(bytesFrom("GIF89a", [0x01]))).toEqual({
      kind: "supported",
      mimeType: "image/gif",
    });
  });

  it("detects WebP in its RIFF container", () => {
    expect(
      detectImageMimeType(
        bytesFrom("RIFF", [0x24, 0x00, 0x00, 0x00], "WEBPVP8X"),
      ),
    ).toEqual({ kind: "supported", mimeType: "image/webp" });
  });

  it("does not treat other RIFF containers as WebP", () => {
    expect(
      detectImageMimeType(
        bytesFrom("RIFF", [0x24, 0x00, 0x00, 0x00], "WAVEfmt "),
      ),
    ).toEqual({ kind: "unknown" });
  });

  it("recognizes HEIC and AVIF phone photos as heif-like", () => {
    for (const brand of ["heic", "heix", "mif1", "avif"]) {
      expect(
        detectImageMimeType(bytesFrom([0x00, 0x00, 0x00, 0x18], "ftyp", brand)),
      ).toEqual({ kind: "heif_like" });
    }
  });

  it("treats other ISO-BMFF files, such as MP4 video, as unknown", () => {
    expect(
      detectImageMimeType(bytesFrom([0x00, 0x00, 0x00, 0x18], "ftyp", "isom")),
    ).toEqual({ kind: "unknown" });
  });

  it("returns unknown for empty and truncated buffers without throwing", () => {
    expect(detectImageMimeType(Uint8Array.of())).toEqual({ kind: "unknown" });
    expect(detectImageMimeType(Uint8Array.of(0xff, 0xd8))).toEqual({
      kind: "unknown",
    });
    expect(detectImageMimeType(bytesFrom("RIFF"))).toEqual({ kind: "unknown" });
  });
});
