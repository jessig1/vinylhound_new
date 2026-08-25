import { z } from "zod";

const BooleanStringSchema = z
  .enum(["true", "false"])
  .transform((value) => value === "true");

export const ServerConfigSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  APP_URL: z.url(),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  S3_ENDPOINT: z.url().optional(),
  S3_REGION: z.string().min(1),
  S3_BUCKET: z.string().min(1),
  S3_ACCESS_KEY_ID: z.string().min(1),
  S3_SECRET_ACCESS_KEY: z.string().min(1),
  S3_FORCE_PATH_STYLE: BooleanStringSchema.default(false),
  OPENAI_API_KEY: z.string().min(1),
  OPENAI_VISION_MODEL: z.string().min(1).default("gpt-5.6-terra"),
  OPENAI_IMAGE_DETAIL: z.enum(["low", "high", "auto"]).default("high"),
});

export type ServerConfig = z.infer<typeof ServerConfigSchema>;

export function loadServerConfig(
  environment: NodeJS.ProcessEnv = process.env,
): ServerConfig {
  return ServerConfigSchema.parse(environment);
}
