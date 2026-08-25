import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";

import { AlbumIdentificationSchema } from "@vinylhound/contracts";

import type {
  AlbumIdentificationRequest,
  AlbumIdentificationResponse,
  AlbumIdentifier,
} from "./album-identifier.js";
import {
  ALBUM_IDENTIFICATION_INSTRUCTIONS,
  ALBUM_IDENTIFICATION_PROMPT_VERSION,
} from "./prompt.js";

export interface OpenAIAlbumIdentifierOptions {
  apiKey: string;
  model: string;
  imageDetail?: "low" | "high" | "auto";
}

export function createOpenAIAlbumIdentifier(
  options: OpenAIAlbumIdentifierOptions,
): AlbumIdentifier {
  const client = new OpenAI({ apiKey: options.apiKey });

  return {
    async identify(
      request: AlbumIdentificationRequest,
    ): Promise<AlbumIdentificationResponse> {
      if (request.imageUrls.length === 0) {
        throw new Error(
          "At least one image URL is required for album identification.",
        );
      }

      const imageContent = request.imageUrls.map((imageUrl) => ({
        type: "input_image" as const,
        image_url: imageUrl,
        detail: options.imageDetail ?? ("high" as const),
      }));

      const response = await client.responses.parse({
        model: options.model,
        store: false,
        instructions: ALBUM_IDENTIFICATION_INSTRUCTIONS,
        input: [
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: request.userHint
                  ? `Identify the vinyl record shown. User hint: ${request.userHint}`
                  : "Identify the vinyl record shown in these images.",
              },
              ...imageContent,
            ],
          },
        ],
        text: {
          format: zodTextFormat(
            AlbumIdentificationSchema,
            "album_identification",
          ),
        },
      });

      if (!response.output_parsed) {
        throw new Error(
          `OpenAI response ${response.id} did not contain a parsed identification.`,
        );
      }

      return {
        identification: response.output_parsed,
        metadata: {
          provider: "openai",
          model: options.model,
          promptVersion: ALBUM_IDENTIFICATION_PROMPT_VERSION,
          providerResponseId: response.id,
        },
      };
    },
  };
}
