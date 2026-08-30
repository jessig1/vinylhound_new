import { describe, expect, it } from "vitest";

import { ServerConfigSchema } from "./index.js";

describe("ServerConfigSchema", () => {
  it("defaults album identification to Sol with high image detail", () => {
    const config = ServerConfigSchema.parse({
      APP_URL: "http://localhost:3000",
      DATABASE_URL: "postgresql://vinylhound:password@localhost/vinylhound",
      REDIS_URL: "redis://localhost:6379",
      S3_REGION: "us-east-1",
      S3_BUCKET: "vinylhound",
      S3_ACCESS_KEY_ID: "local-access-key",
      S3_SECRET_ACCESS_KEY: "local-secret-key",
      OPENAI_API_KEY: "test-key",
    });

    expect(config.OPENAI_VISION_MODEL).toBe("gpt-5.6-sol");
    expect(config.OPENAI_IMAGE_DETAIL).toBe("high");
  });
});
