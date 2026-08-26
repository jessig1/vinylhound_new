import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

import type {
  CreateUploadRequest,
  ObjectStorage,
  StoredObject,
} from "./index.js";

export interface S3ObjectStorageOptions {
  endpoint?: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle?: boolean;
  uploadUrlTtlSeconds?: number;
}

export class StoredObjectTooLargeError extends Error {
  constructor() {
    super("The stored object exceeds the allowed size.");
    this.name = "StoredObjectTooLargeError";
  }
}

export class StoredObjectNotFoundError extends Error {
  constructor() {
    super("The stored object does not exist.");
    this.name = "StoredObjectNotFoundError";
  }
}

export function createS3ObjectStorage(
  options: S3ObjectStorageOptions,
): ObjectStorage {
  const client = new S3Client({
    endpoint: options.endpoint,
    region: options.region,
    forcePathStyle: options.forcePathStyle,
    credentials: {
      accessKeyId: options.accessKeyId,
      secretAccessKey: options.secretAccessKey,
    },
  });
  const uploadUrlTtlSeconds = options.uploadUrlTtlSeconds ?? 300;

  return {
    async createSignedUpload(request: CreateUploadRequest) {
      const command = new PutObjectCommand({
        Bucket: options.bucket,
        Key: request.objectKey,
        ContentType: request.mimeType,
        Metadata: {
          "expected-sha256": request.checksumSha256,
          "expected-size": String(request.sizeBytes),
        },
      });
      const url = await getSignedUrl(client, command, {
        expiresIn: uploadUrlTtlSeconds,
        signableHeaders: new Set(["content-type"]),
      });

      return {
        method: "PUT" as const,
        url,
        expiresAt: new Date(Date.now() + uploadUrlTtlSeconds * 1_000),
        requiredHeaders: {
          "content-type": request.mimeType,
        },
      };
    },

    async readObject(
      objectKey: string,
      maxBytes: number,
    ): Promise<StoredObject> {
      let head;
      try {
        head = await client.send(
          new HeadObjectCommand({ Bucket: options.bucket, Key: objectKey }),
        );
      } catch (error) {
        if (
          error instanceof S3ServiceException &&
          (error.$metadata.httpStatusCode === 404 || error.name === "NoSuchKey")
        ) {
          throw new StoredObjectNotFoundError();
        }
        throw error;
      }
      if (head.ContentLength === undefined || head.ContentLength > maxBytes) {
        throw new StoredObjectTooLargeError();
      }

      const object = await client.send(
        new GetObjectCommand({ Bucket: options.bucket, Key: objectKey }),
      );
      if (!object.Body) {
        throw new Error("The stored object has no response body.");
      }

      const bytes = await object.Body.transformToByteArray();
      if (bytes.byteLength > maxBytes) {
        throw new StoredObjectTooLargeError();
      }
      if (bytes.byteLength !== head.ContentLength) {
        throw new Error("The stored object changed while it was being read.");
      }

      return {
        bytes,
        contentType: object.ContentType ?? head.ContentType,
        sizeBytes: bytes.byteLength,
      };
    },

    async createSignedReadUrl(objectKey: string, expiresInSeconds: number) {
      return getSignedUrl(
        client,
        new GetObjectCommand({ Bucket: options.bucket, Key: objectKey }),
        { expiresIn: expiresInSeconds },
      );
    },

    async deleteObject(objectKey: string) {
      await client.send(
        new DeleteObjectCommand({ Bucket: options.bucket, Key: objectKey }),
      );
    },
  };
}
