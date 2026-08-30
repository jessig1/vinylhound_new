import type {
  AlbumIdentification,
  ImageViewType,
  ProviderErrorCategory,
} from "@vinylhound/contracts";

export interface AlbumIdentificationImage {
  url: string;
  viewType: ImageViewType;
}

export interface AlbumIdentificationRequest {
  scanId: string;
  images: readonly AlbumIdentificationImage[];
  userHint?: string;
}

export interface AlbumIdentificationMetadata {
  provider: "openai";
  model: string;
  promptVersion: string;
  providerResponseId: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  } | null;
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

export class AlbumIdentificationError extends Error {
  constructor(
    readonly category: ProviderErrorCategory,
    readonly retryable: boolean,
    message: string,
  ) {
    super(message);
    this.name = "AlbumIdentificationError";
  }
}
