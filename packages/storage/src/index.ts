export interface CreateUploadRequest {
  objectKey: string;
  mimeType: "image/jpeg" | "image/png" | "image/webp" | "image/gif";
  sizeBytes: number;
  checksumSha256: string;
}

export interface SignedUpload {
  method: "PUT";
  url: string;
  expiresAt: Date;
  requiredHeaders: Readonly<Record<string, string>>;
}

export interface StoredObject {
  bytes: Uint8Array;
  contentType: string | undefined;
  sizeBytes: number;
}

export interface ObjectStorage {
  createSignedUpload(request: CreateUploadRequest): Promise<SignedUpload>;
  readObject(objectKey: string, maxBytes: number): Promise<StoredObject>;
  createSignedReadUrl(
    objectKey: string,
    expiresInSeconds: number,
  ): Promise<string>;
  deleteObject(objectKey: string): Promise<void>;
}

export * from "./image-validation.js";
export * from "./s3-object-storage.js";
