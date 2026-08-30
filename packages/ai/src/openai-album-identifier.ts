import OpenAI from "openai";
import {
  ContentFilterFinishReasonError,
  LengthFinishReasonError,
} from "openai/core/error";
import { zodTextFormat } from "openai/helpers/zod";
import { z } from "zod";

import { AlbumIdentificationSchema } from "@vinylhound/contracts";

import type {
  AlbumIdentificationRequest,
  AlbumIdentificationResponse,
  AlbumIdentifier,
} from "./album-identifier.js";
import { AlbumIdentificationError } from "./album-identifier.js";
import {
  ALBUM_IDENTIFICATION_INSTRUCTIONS,
  ALBUM_IDENTIFICATION_PROMPT_VERSION,
} from "./prompt.js";

export interface OpenAIAlbumIdentifierOptions {
  apiKey: string;
  model: string;
  imageDetail?: "low" | "high" | "auto";
  timeoutMs?: number;
}

export function createOpenAIAlbumIdentifier(
  options: OpenAIAlbumIdentifierOptions,
): AlbumIdentifier {
  const client = new OpenAI({
    apiKey: options.apiKey,
    maxRetries: 0,
    timeout: options.timeoutMs ?? 120_000,
  });

  return {
    async identify(
      request: AlbumIdentificationRequest,
    ): Promise<AlbumIdentificationResponse> {
      if (request.images.length === 0) {
        throw new Error(
          "At least one image URL is required for album identification.",
        );
      }

      let response;
      try {
        response = await client.responses.parse({
          model: options.model,
          store: false,
          instructions: ALBUM_IDENTIFICATION_INSTRUCTIONS,
          input: [
            {
              role: "user",
              content: buildAlbumIdentificationContent(
                request,
                options.imageDetail ?? "high",
              ),
            },
          ],
          text: {
            format: zodTextFormat(
              AlbumIdentificationSchema,
              "album_identification",
            ),
          },
        });
      } catch (error) {
        throw normalizeOpenAIError(error);
      }

      if (!response.output_parsed) {
        const refused = response.output.some(
          (item) =>
            item.type === "message" &&
            item.content.some((content) => content.type === "refusal"),
        );
        throw new AlbumIdentificationError(
          refused ? "refusal" : "schema_invalid",
          false,
          refused
            ? "The image analysis request was refused."
            : "The image analysis response did not match the required schema.",
        );
      }

      return {
        identification: response.output_parsed,
        metadata: {
          provider: "openai",
          model: response.model,
          promptVersion: ALBUM_IDENTIFICATION_PROMPT_VERSION,
          providerResponseId: response.id,
          usage: response.usage
            ? {
                inputTokens: response.usage.input_tokens,
                outputTokens: response.usage.output_tokens,
                totalTokens: response.usage.total_tokens,
              }
            : null,
        },
      };
    },
  };
}

export function buildAlbumIdentificationContent(
  request: AlbumIdentificationRequest,
  imageDetail: "low" | "high" | "auto",
) {
  return [
    {
      type: "input_text" as const,
      text: request.userHint
        ? `Identify the vinyl record shown. User hint: ${request.userHint}`
        : "Identify the vinyl record shown in these images.",
    },
    ...request.images.flatMap((image, index) => [
      {
        type: "input_text" as const,
        text: `View ${index + 1}: ${image.viewType}.`,
      },
      {
        type: "input_image" as const,
        image_url: image.url,
        detail: imageDetail,
      },
    ]),
  ];
}

export function normalizeOpenAIError(error: unknown) {
  if (error instanceof AlbumIdentificationError) {
    return error;
  }
  if (error instanceof OpenAI.APIConnectionTimeoutError) {
    return new AlbumIdentificationError(
      "timeout",
      true,
      "The image analysis provider timed out.",
    );
  }
  if (error instanceof OpenAI.RateLimitError) {
    return new AlbumIdentificationError(
      "rate_limit",
      true,
      "The image analysis provider is temporarily rate limited.",
    );
  }
  if (error instanceof ContentFilterFinishReasonError) {
    return new AlbumIdentificationError(
      "refusal",
      false,
      "The image analysis request was refused.",
    );
  }
  if (error instanceof LengthFinishReasonError || error instanceof z.ZodError) {
    return new AlbumIdentificationError(
      "schema_invalid",
      false,
      "The image analysis response did not match the required schema.",
    );
  }
  if (
    error instanceof OpenAI.APIConnectionError ||
    (error instanceof OpenAI.APIError &&
      error.status !== undefined &&
      error.status >= 500)
  ) {
    return new AlbumIdentificationError(
      "provider_unavailable",
      true,
      "The image analysis provider is temporarily unavailable.",
    );
  }
  if (
    error instanceof OpenAI.APIError &&
    (error.code === "invalid_image" || error.status === 422)
  ) {
    return new AlbumIdentificationError(
      "invalid_image",
      false,
      "The image analysis provider could not process an image.",
    );
  }

  return new AlbumIdentificationError(
    "unknown",
    false,
    "The image analysis request failed.",
  );
}
