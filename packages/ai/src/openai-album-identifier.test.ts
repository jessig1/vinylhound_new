import OpenAI from "openai";
import { describe, expect, it } from "vitest";

import { normalizeOpenAIError } from "./openai-album-identifier.js";

describe("normalizeOpenAIError", () => {
  it("marks timeouts and rate limits retryable", () => {
    expect(
      normalizeOpenAIError(new OpenAI.APIConnectionTimeoutError({})),
    ).toMatchObject({ category: "timeout", retryable: true });
    expect(
      normalizeOpenAIError(
        new OpenAI.RateLimitError(
          429,
          { code: "rate_limit_exceeded" },
          undefined,
          new Headers(),
        ),
      ),
    ).toMatchObject({ category: "rate_limit", retryable: true });
  });

  it("treats provider server failures as transient", () => {
    expect(
      normalizeOpenAIError(
        new OpenAI.InternalServerError(
          503,
          { code: "server_error" },
          undefined,
          new Headers(),
        ),
      ),
    ).toMatchObject({ category: "provider_unavailable", retryable: true });
  });

  it("uses a safe terminal category for unknown failures", () => {
    expect(
      normalizeOpenAIError(new Error("secret provider detail")),
    ).toMatchObject({
      category: "unknown",
      retryable: false,
      message: "The image analysis request failed.",
    });
  });
});
