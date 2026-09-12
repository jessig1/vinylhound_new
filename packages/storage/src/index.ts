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

export interface PutObjectRequest {
  objectKey: string;
  bytes: Uint8Array;
  contentType: string;
}

export interface ObjectStorage {
  createSignedUpload(request: CreateUploadRequest): Promise<SignedUpload>;
  putObject(request: PutObjectRequest): Promise<void>;
  readObject(objectKey: string, maxBytes: number): Promise<StoredObject>;
  createSignedReadUrl(
    objectKey: string,
    expiresInSeconds: number,
  ): Promise<string>;
  deleteObject(objectKey: string): Promise<void>;
}

export * from "./image-normalization.ts";
export * from "./image-validation.ts";
export * from "./s3-object-storage.ts";
