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

export interface ObjectStorage {
  createSignedUpload(request: CreateUploadRequest): Promise<SignedUpload>;
  createSignedReadUrl(
    objectKey: string,
    expiresInSeconds: number,
  ): Promise<string>;
  deleteObject(objectKey: string): Promise<void>;
}
