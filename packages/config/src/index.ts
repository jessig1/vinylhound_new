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
  DATABASE_MAX_CONNECTIONS: z.coerce.number().int().min(1).max(50).default(5),
  DATABASE_CONNECT_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .max(120_000)
    .default(30_000),
  DATABASE_SSL_MODE: z
    .enum(["disable", "require", "verify-full"])
    .default("disable"),
  DATABASE_SSL_CA_BASE64: OptionalNonEmptyStringSchema,
  REDIS_URL: z.string().min(1),
  S3_ENDPOINT: z.url().optional(),
  S3_REGION: z.string().min(1),
  S3_BUCKET: z.string().min(1),
  S3_ACCESS_KEY_ID: OptionalNonEmptyStringSchema,
  S3_SECRET_ACCESS_KEY: OptionalNonEmptyStringSchema,
  S3_FORCE_PATH_STYLE: BooleanStringSchema.default(false),
  DEPLOYMENT_VERSION: z.string().min(1).default("development"),
};

function validateInfrastructureConfig(
  value: {
    DATABASE_SSL_MODE: "disable" | "require" | "verify-full";
    DATABASE_SSL_CA_BASE64?: string;
    S3_ACCESS_KEY_ID?: string;
    S3_SECRET_ACCESS_KEY?: string;
  },
  ctx: z.RefinementCtx,
) {
  if (Boolean(value.S3_ACCESS_KEY_ID) !== Boolean(value.S3_SECRET_ACCESS_KEY)) {
    ctx.addIssue({
      code: "custom",
      path: ["S3_ACCESS_KEY_ID"],
      message: "S3 access key ID and secret must be provided together.",
    });
  }
  if (
    value.DATABASE_SSL_MODE === "verify-full" &&
    !value.DATABASE_SSL_CA_BASE64
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["DATABASE_SSL_CA_BASE64"],
      message: "A CA certificate is required for verify-full database TLS.",
    });
  }
}

const AuthModeSchema = z
  .enum(["development", "production"])
  .default("development");

const OperationsConfigShape = {
  // These limits are enforced before a scan job enters the durable outbox.
  // Keep the defaults generous enough for local batch testing; production
  // deployments should set values appropriate to their OpenAI project budget.
  USER_DAILY_ANALYSIS_LIMIT: z.coerce
    .number()
    .int()
    .min(1)
    .max(10_000)
    .default(100),
  USER_ACTIVE_SCAN_LIMIT: z.coerce.number().int().min(1).max(100).default(20),
  USER_MONTHLY_SPEND_LIMIT_USD: z.coerce
    .number()
    .positive()
    .max(10_000)
    .default(20),
  SCAN_COST_RESERVATION_USD: z.coerce
    .number()
    .positive()
    .max(100)
    .default(0.25),
};

export const DevelopmentWebConfigSchema = z
  .object({
    NODE_ENV: NodeEnvironmentSchema,
    ...InfrastructureConfigShape,
    AUTH_MODE: AuthModeSchema,
    NEXT_PUBLIC_AUTH_MODE: AuthModeSchema,
    DEVELOPMENT_USER_ID: z
      .string()
      .uuid()
      .default("00000000-0000-4000-8000-000000000001"),
    CLERK_SECRET_KEY: OptionalNonEmptyStringSchema,
    NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: OptionalNonEmptyStringSchema,
    ...OperationsConfigShape,
  })
  .superRefine((value, ctx) => {
    validateInfrastructureConfig(value, ctx);
    if (value.AUTH_MODE !== value.NEXT_PUBLIC_AUTH_MODE) {
      ctx.addIssue({
        code: "custom",
        path: ["NEXT_PUBLIC_AUTH_MODE"],
        message: "NEXT_PUBLIC_AUTH_MODE must match AUTH_MODE.",
      });
    }
    if (value.AUTH_MODE !== "production") return;
    if (!value.CLERK_SECRET_KEY) {
      ctx.addIssue({
        code: "custom",
        path: ["CLERK_SECRET_KEY"],
        message: "CLERK_SECRET_KEY is required when AUTH_MODE is production.",
      });
    }
    if (!value.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY) {
      ctx.addIssue({
        code: "custom",
        path: ["NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY"],
        message:
          "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY is required when AUTH_MODE is production.",
      });
    }
  });

export const ServerConfigSchema = z
  .object({
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
  })
  .superRefine(validateInfrastructureConfig);

export const QueueWorkerConfigSchema = z
  .object({
    NODE_ENV: NodeEnvironmentSchema,
    DATABASE_URL: z.string().min(1),
    DATABASE_MAX_CONNECTIONS: z.coerce.number().int().min(1).max(50).default(5),
    DATABASE_CONNECT_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(1_000)
      .max(120_000)
      .default(30_000),
    DATABASE_SSL_MODE: z
      .enum(["disable", "require", "verify-full"])
      .default("disable"),
    DATABASE_SSL_CA_BASE64: OptionalNonEmptyStringSchema,
    REDIS_URL: z.string().min(1),
    S3_ENDPOINT: z.url().optional(),
    S3_REGION: z.string().min(1),
    S3_BUCKET: z.string().min(1),
    S3_ACCESS_KEY_ID: OptionalNonEmptyStringSchema,
    S3_SECRET_ACCESS_KEY: OptionalNonEmptyStringSchema,
    S3_FORCE_PATH_STYLE: BooleanStringSchema.default(false),
    DEPLOYMENT_VERSION: z.string().min(1).default("development"),
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
    CLOUDWATCH_METRICS_ENABLED: BooleanStringSchema.default(false),
    CLOUDWATCH_METRIC_NAMESPACE: z.string().min(1).default("VinylHound"),
    CLOUDWATCH_METRICS_INTERVAL_MS: z.coerce
      .number()
      .int()
      .min(30_000)
      .max(300_000)
      .default(60_000),
    ENVIRONMENT_NAME: z.string().min(1).default("development"),
  })
  .superRefine(validateInfrastructureConfig);

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
