import { describe, expect, it } from "vitest";

import {
  DevelopmentWebConfigSchema,
  DiscoveryServiceConfigSchema,
  QueueWorkerConfigSchema,
  ServerConfigSchema,
} from "./index.ts";

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
    expect(config.DATABASE_MAX_CONNECTIONS).toBe(5);
    expect(config.DATABASE_CONNECT_TIMEOUT_MS).toBe(30_000);
  });

  it("accepts task-role S3 credentials and verified database TLS", () => {
    const config = ServerConfigSchema.parse({
      APP_URL: "https://vinylhound.example",
      DATABASE_URL: "postgresql://vinylhound:password@db/vinylhound",
      DATABASE_SSL_MODE: "verify-full",
      DATABASE_SSL_CA_BASE64: Buffer.from("test-ca").toString("base64"),
      REDIS_URL: "rediss://cache:6379",
      S3_REGION: "us-east-1",
      S3_BUCKET: "vinylhound",
      OPENAI_API_KEY: "test-key",
    });

    expect(config.S3_ACCESS_KEY_ID).toBeUndefined();
    expect(config.DATABASE_SSL_MODE).toBe("verify-full");
  });

  it("rejects partial S3 credentials and verify-full without a CA", () => {
    const partialCredentials = ServerConfigSchema.safeParse({
      APP_URL: "https://vinylhound.example",
      DATABASE_URL: "postgresql://vinylhound:password@db/vinylhound",
      REDIS_URL: "rediss://cache:6379",
      S3_REGION: "us-east-1",
      S3_BUCKET: "vinylhound",
      S3_ACCESS_KEY_ID: "only-half",
      OPENAI_API_KEY: "test-key",
    });
    const missingCa = ServerConfigSchema.safeParse({
      APP_URL: "https://vinylhound.example",
      DATABASE_URL: "postgresql://vinylhound:password@db/vinylhound",
      DATABASE_SSL_MODE: "verify-full",
      REDIS_URL: "rediss://cache:6379",
      S3_REGION: "us-east-1",
      S3_BUCKET: "vinylhound",
      OPENAI_API_KEY: "test-key",
    });

    expect(partialCredentials.success).toBe(false);
    expect(missingCa.success).toBe(false);
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

  it("defaults to no discovery service, keeping the in-process adapters", () => {
    const config = DevelopmentWebConfigSchema.parse(baseEnv);

    expect(config.DISCOVERY_SERVICE_URL).toBeUndefined();
    expect(config.DISCOVERY_SERVICE_SHARED_SECRET).toBeUndefined();
  });

  it("rejects a discovery service URL without its shared secret, and vice versa", () => {
    const urlOnly = DevelopmentWebConfigSchema.safeParse({
      ...baseEnv,
      DISCOVERY_SERVICE_URL: "http://discovery.internal:4001",
    });
    const secretOnly = DevelopmentWebConfigSchema.safeParse({
      ...baseEnv,
      DISCOVERY_SERVICE_SHARED_SECRET: "a".repeat(32),
    });

    expect(urlOnly.success).toBe(false);
    expect(secretOnly.success).toBe(false);
  });

  it("rejects a discovery service shared secret shorter than 32 characters", () => {
    const result = DevelopmentWebConfigSchema.safeParse({
      ...baseEnv,
      DISCOVERY_SERVICE_URL: "http://discovery.internal:4001",
      DISCOVERY_SERVICE_SHARED_SECRET: "too-short",
    });

    expect(result.success).toBe(false);
  });

  it("accepts a discovery service URL paired with a long enough shared secret", () => {
    const config = DevelopmentWebConfigSchema.parse({
      ...baseEnv,
      DISCOVERY_SERVICE_URL: "http://discovery.internal:4001",
      DISCOVERY_SERVICE_SHARED_SECRET: "a".repeat(32),
    });

    expect(config.DISCOVERY_SERVICE_URL).toBe("http://discovery.internal:4001");
  });
});

describe("DiscoveryServiceConfigSchema", () => {
  const baseEnv = {
    APP_URL: "http://localhost:3000",
    DISCOVERY_SERVICE_SHARED_SECRET: "a".repeat(32),
  };

  it("defaults the port and requires no database or storage credentials", () => {
    const config = DiscoveryServiceConfigSchema.parse(baseEnv);

    expect(config.DISCOVERY_SERVICE_PORT).toBe(4_001);
    expect(config.SPOTIFY_CLIENT_ID).toBeUndefined();
  });

  it("rejects a shared secret shorter than 32 characters", () => {
    const result = DiscoveryServiceConfigSchema.safeParse({
      ...baseEnv,
      DISCOVERY_SERVICE_SHARED_SECRET: "too-short",
    });

    expect(result.success).toBe(false);
  });

  it("rejects partial Spotify credentials", () => {
    const result = DiscoveryServiceConfigSchema.safeParse({
      ...baseEnv,
      SPOTIFY_CLIENT_ID: "only-the-id",
    });

    expect(result.success).toBe(false);
  });

  it("accepts paired Spotify credentials", () => {
    const config = DiscoveryServiceConfigSchema.parse({
      ...baseEnv,
      SPOTIFY_CLIENT_ID: "id",
      SPOTIFY_CLIENT_SECRET: "secret",
    });

    expect(config.SPOTIFY_CLIENT_ID).toBe("id");
  });
});

describe("QueueWorkerConfigSchema", () => {
  const baseEnv = {
    DATABASE_URL: "postgresql://vinylhound:password@localhost/vinylhound",
    S3_REGION: "us-east-1",
    S3_BUCKET: "vinylhound",
  };

  it("defaults to BullMQ and requires Redis", () => {
    expect(QueueWorkerConfigSchema.safeParse(baseEnv).success).toBe(false);
    expect(
      QueueWorkerConfigSchema.parse({
        ...baseEnv,
        REDIS_URL: "redis://localhost:6379",
      }).QUEUE_DRIVER,
    ).toBe("bullmq");
  });

  it("accepts SQS without a Redis URL", () => {
    const config = QueueWorkerConfigSchema.parse({
      ...baseEnv,
      QUEUE_DRIVER: "sqs",
      SQS_QUEUE_URL: "https://sqs.us-east-1.amazonaws.com/123/scans.fifo",
      SQS_DEAD_LETTER_QUEUE_URL:
        "https://sqs.us-east-1.amazonaws.com/123/scans-dlq.fifo",
      // P4.2 Task 3: the two confirmation-pipeline queues, also required
      // under QUEUE_DRIVER=sqs.
      SQS_CONFIRMATION_PROCESSING_QUEUE_URL:
        "https://sqs.us-east-1.amazonaws.com/123/confirmation-processing.fifo",
      SQS_CONFIRMATION_COMPLETION_QUEUE_URL:
        "https://sqs.us-east-1.amazonaws.com/123/confirmation-completion.fifo",
    });

    expect(config.REDIS_URL).toBeUndefined();
    expect(config.SQS_MAX_RECEIVE_COUNT).toBe(5);
    expect(config.SQS_VISIBILITY_TIMEOUT_SECONDS).toBe(180);
  });

  it("rejects SQS without a queue URL", () => {
    expect(
      QueueWorkerConfigSchema.safeParse({
        ...baseEnv,
        QUEUE_DRIVER: "sqs",
      }).success,
    ).toBe(false);
  });

  it("defaults abandoned-upload cleanup to a 24-hour TTL and 30-minute interval", () => {
    const config = QueueWorkerConfigSchema.parse({
      ...baseEnv,
      REDIS_URL: "redis://localhost:6379",
    });

    expect(config.ABANDONED_UPLOAD_TTL_HOURS).toBe(24);
    expect(config.ABANDONED_UPLOAD_CLEANUP_INTERVAL_MS).toBe(1_800_000);
    expect(config.ABANDONED_UPLOAD_CLEANUP_BATCH_SIZE).toBe(50);
  });

  it("rejects an abandoned-upload cleanup interval below one minute", () => {
    expect(
      QueueWorkerConfigSchema.safeParse({
        ...baseEnv,
        REDIS_URL: "redis://localhost:6379",
        ABANDONED_UPLOAD_CLEANUP_INTERVAL_MS: "1000",
      }).success,
    ).toBe(false);
  });

  it("defaults confirmation reconciliation to a 1-minute poll and 5-minute staleness threshold", () => {
    const config = QueueWorkerConfigSchema.parse({
      ...baseEnv,
      REDIS_URL: "redis://localhost:6379",
    });

    expect(config.CONFIRMATION_RECONCILIATION_POLL_INTERVAL_MS).toBe(60_000);
    expect(config.CONFIRMATION_RECONCILIATION_STALE_AFTER_MS).toBe(300_000);
    expect(config.CONFIRMATION_RECONCILIATION_BATCH_SIZE).toBe(50);
  });

  it("rejects a confirmation reconciliation staleness threshold below ten seconds", () => {
    expect(
      QueueWorkerConfigSchema.safeParse({
        ...baseEnv,
        REDIS_URL: "redis://localhost:6379",
        CONFIRMATION_RECONCILIATION_STALE_AFTER_MS: "1000",
      }).success,
    ).toBe(false);
  });
});
