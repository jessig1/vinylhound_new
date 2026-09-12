import { createHash, randomUUID } from "node:crypto";

import sharp from "sharp";
import { describe, expect, it } from "vitest";

import { createS3ObjectStorage } from "./s3-object-storage.ts";

const requiredEnvironment = [
  "S3_REGION",
  "S3_BUCKET",
  "S3_ACCESS_KEY_ID",
  "S3_SECRET_ACCESS_KEY",
] as const;

for (const name of requiredEnvironment) {
  if (!process.env[name]) {
    throw new Error(`${name} is required for storage integration tests.`);
  }
}

const storage = createS3ObjectStorage({
  endpoint: process.env.S3_ENDPOINT,
  region: process.env.S3_REGION!,
  bucket: process.env.S3_BUCKET!,
  accessKeyId: process.env.S3_ACCESS_KEY_ID!,
  secretAccessKey: process.env.S3_SECRET_ACCESS_KEY!,
  forcePathStyle: process.env.S3_FORCE_PATH_STYLE === "true",
});

describe("S3-compatible object storage", () => {
  it("signs, uploads, reads, and deletes an object", async () => {
    const objectKey = `integration/${randomUUID()}/original`;
    const bytes = await sharp({
      create: {
        width: 8,
        height: 8,
        channels: 3,
        background: "#121212",
      },
    })
      .jpeg()
      .toBuffer();
    const checksumSha256 = createHash("sha256").update(bytes).digest("hex");

    try {
      const signed = await storage.createSignedUpload({
        objectKey,
        mimeType: "image/jpeg",
        sizeBytes: bytes.byteLength,
        checksumSha256,
      });
      const upload = await fetch(signed.url, {
        method: signed.method,
        headers: signed.requiredHeaders,
        body: bytes,
      });
      expect(upload.status).toBe(200);

      const stored = await storage.readObject(objectKey, 1024 * 1024);
      expect(stored.contentType).toBe("image/jpeg");
      expect(Buffer.from(stored.bytes)).toEqual(bytes);
    } finally {
      await storage.deleteObject(objectKey);
    }
  });
});
