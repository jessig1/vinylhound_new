import { createHash } from "node:crypto";

import sharp from "sharp";
import { describe, expect, it } from "vitest";

import { validateImage } from "./image-validation.js";

async function createPng() {
  return sharp({
    create: {
      width: 20,
      height: 30,
      channels: 3,
      background: "#4f3727",
    },
  })
    .png()
    .toBuffer();
}

describe("validateImage", () => {
  it("checks the signature, checksum, dimensions, and decoder", async () => {
    const bytes = await createPng();
    const checksum = createHash("sha256").update(bytes).digest("hex");

    await expect(
      validateImage({
        bytes,
        storedContentType: "image/png",
        expectedMimeType: "image/png",
        expectedSizeBytes: bytes.byteLength,
        expectedChecksumSha256: checksum,
      }),
    ).resolves.toMatchObject({
      mimeType: "image/png",
      sizeBytes: bytes.byteLength,
      checksumSha256: checksum,
      width: 20,
      height: 30,
    });
  });

  it("rejects bytes whose decoded type disagrees with the declaration", async () => {
    const bytes = await createPng();

    await expect(
      validateImage({
        bytes,
        storedContentType: "image/jpeg",
        expectedMimeType: "image/jpeg",
        expectedSizeBytes: bytes.byteLength,
        expectedChecksumSha256: createHash("sha256")
          .update(bytes)
          .digest("hex"),
      }),
    ).rejects.toMatchObject({ code: "mime_mismatch" });
  });
});
