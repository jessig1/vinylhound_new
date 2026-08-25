import type { AlbumIdentification } from "@vinylhound/contracts";

export interface AlbumIdentificationRequest {
  scanId: string;
  imageUrls: readonly string[];
  userHint?: string;
}

export interface AlbumIdentificationMetadata {
  provider: "openai";
  model: string;
  promptVersion: string;
  providerResponseId: string;
}

export interface AlbumIdentificationResponse {
  identification: AlbumIdentification;
  metadata: AlbumIdentificationMetadata;
}

export interface AlbumIdentifier {
  identify(
    request: AlbumIdentificationRequest,
  ): Promise<AlbumIdentificationResponse>;
}
