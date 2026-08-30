import { z } from "zod";

const BooleanStringSchema = z
  .enum(["true", "false"])
  .transform((value) => value === "true");

const NodeEnvironmentSchema = z
  .enum(["development", "test", "production"])
  .default("development");

const OptionalNonEmptyStringSchema = z.preprocess(
  (value) =>
    typeof value === "string" && value.trim() === "" ? undefined : value,
  z.string().min(1).optional(),
);

const InfrastructureConfigShape = {
  APP_URL: z.url(),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  S3_ENDPOINT: z.url().optional(),
  S3_REGION: z.string().min(1),
  S3_BUCKET: z.string().min(1),
  S3_ACCESS_KEY_ID: z.string().min(1),
  S3_SECRET_ACCESS_KEY: z.string().min(1),
  S3_FORCE_PATH_STYLE: BooleanStringSchema.default(false),
};

export const DevelopmentWebConfigSchema = z.object({
  NODE_ENV: NodeEnvironmentSchema,
  ...InfrastructureConfigShape,
  AUTH_MODE: z.literal("development").default("development"),
  DEVELOPMENT_USER_ID: z
    .string()
    .uuid()
    .default("00000000-0000-4000-8000-000000000001"),
});

export const ServerConfigSchema = z.object({
  NODE_ENV: NodeEnvironmentSchema,
  ...InfrastructureConfigShape,
  OPENAI_API_KEY: z.string().min(1),
  OPENAI_VISION_MODEL: z.string().min(1).default("gpt-5.6-sol"),
  OPENAI_IMAGE_DETAIL: z.enum(["low", "high", "auto"]).default("high"),
  OPENAI_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .max(600_000)
    .default(120_000),
});

export const QueueWorkerConfigSchema = z.object({
  NODE_ENV: NodeEnvironmentSchema,
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  S3_ENDPOINT: z.url().optional(),
  S3_REGION: z.string().min(1),
  S3_BUCKET: z.string().min(1),
  S3_ACCESS_KEY_ID: z.string().min(1),
  S3_SECRET_ACCESS_KEY: z.string().min(1),
  S3_FORCE_PATH_STYLE: BooleanStringSchema.default(false),
  OPENAI_API_KEY: OptionalNonEmptyStringSchema,
  OPENAI_VISION_MODEL: z.string().min(1).default("gpt-5.6-sol"),
  OPENAI_IMAGE_DETAIL: z.enum(["low", "high", "auto"]).default("high"),
  OPENAI_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .max(600_000)
    .default(120_000),
  SCAN_QUEUE_NAME: z.string().min(1).default("vinylhound-scans"),
  OUTBOX_POLL_INTERVAL_MS: z.coerce.number().int().min(100).default(1_000),
  ANALYSIS_CONCURRENCY: z.coerce.number().int().min(1).max(10).default(1),
});

export type ServerConfig = z.infer<typeof ServerConfigSchema>;
export type DevelopmentWebConfig = z.infer<typeof DevelopmentWebConfigSchema>;
export type QueueWorkerConfig = z.infer<typeof QueueWorkerConfigSchema>;

export function loadDevelopmentWebConfig(
  environment: NodeJS.ProcessEnv = process.env,
): DevelopmentWebConfig {
  return DevelopmentWebConfigSchema.parse(environment);
}

export function loadServerConfig(
  environment: NodeJS.ProcessEnv = process.env,
): ServerConfig {
  return ServerConfigSchema.parse(environment);
}

export function loadQueueWorkerConfig(
  environment: NodeJS.ProcessEnv = process.env,
): QueueWorkerConfig {
  return QueueWorkerConfigSchema.parse(environment);
}
