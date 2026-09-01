import { describe, expect, it } from "vitest";

import { DevelopmentWebConfigSchema, ServerConfigSchema } from "./index.js";

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

describe("DevelopmentWebConfigSchema", () => {
  const baseEnv = {
    APP_URL: "http://localhost:3000",
    DATABASE_URL: "postgresql://vinylhound:password@localhost/vinylhound",
    REDIS_URL: "redis://localhost:6379",
    S3_REGION: "us-east-1",
    S3_BUCKET: "vinylhound",
    S3_ACCESS_KEY_ID: "local-access-key",
    S3_SECRET_ACCESS_KEY: "local-secret-key",
  };

  it("defaults to development auth with no Clerk keys required", () => {
    const config = DevelopmentWebConfigSchema.parse(baseEnv);

    expect(config.AUTH_MODE).toBe("development");
    expect(config.NEXT_PUBLIC_AUTH_MODE).toBe("development");
    expect(config.CLERK_SECRET_KEY).toBeUndefined();
    expect(config.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY).toBeUndefined();
  });

  it("rejects AUTH_MODE=production without Clerk keys", () => {
    const result = DevelopmentWebConfigSchema.safeParse({
      ...baseEnv,
      AUTH_MODE: "production",
      NEXT_PUBLIC_AUTH_MODE: "production",
    });

    expect(result.success).toBe(false);
  });

  it("accepts AUTH_MODE=production with Clerk keys and matching public mode", () => {
    const config = DevelopmentWebConfigSchema.parse({
      ...baseEnv,
      AUTH_MODE: "production",
      NEXT_PUBLIC_AUTH_MODE: "production",
      CLERK_SECRET_KEY: "sk_test_x",
      NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_test_x",
    });

    expect(config.AUTH_MODE).toBe("production");
  });

  it("rejects AUTH_MODE and NEXT_PUBLIC_AUTH_MODE disagreeing", () => {
    const result = DevelopmentWebConfigSchema.safeParse({
      ...baseEnv,
      AUTH_MODE: "development",
      NEXT_PUBLIC_AUTH_MODE: "production",
    });

    expect(result.success).toBe(false);
  });

  it("provides bounded operational safeguards by default", () => {
    const config = DevelopmentWebConfigSchema.parse(baseEnv);

    expect(config.USER_DAILY_ANALYSIS_LIMIT).toBe(100);
    expect(config.USER_ACTIVE_SCAN_LIMIT).toBe(20);
    expect(config.USER_MONTHLY_SPEND_LIMIT_USD).toBe(20);
    expect(config.SCAN_COST_RESERVATION_USD).toBe(0.25);
  });

  it("rejects a non-positive spend reservation", () => {
    const result = DevelopmentWebConfigSchema.safeParse({
      ...baseEnv,
      SCAN_COST_RESERVATION_USD: "0",
    });

    expect(result.success).toBe(false);
  });
});
