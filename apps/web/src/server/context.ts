import path from "node:path";

import { loadEnvConfig } from "@next/env";

import { loadDevelopmentWebConfig } from "@vinylhound/config";
import { createMusicBrainzCatalog } from "@vinylhound/catalog";
import {
  createDatabase,
  databaseOptionsFromConfig,
} from "@vinylhound/database";
import { createS3ObjectStorage } from "@vinylhound/storage";

// forceReload (4th arg) is required: Next.js's own internal loadEnvConfig
// call runs first, scoped to this directory (apps/web, no monorepo-root
// .env), and caches that result at module scope inside @next/env. Without
// forceReload, this call silently returns that stale cache instead of ever
// reading the root .env — discovered when AUTH_MODE and Clerk's keys came
// back undefined at request time despite being set correctly in .env.
loadEnvConfig(
  path.resolve(process.cwd(), "../.."),
  process.env.NODE_ENV !== "production",
  console,
  true,
);

function createServerContext() {
  const config = loadDevelopmentWebConfig();

  return {
    config,
    database: createDatabase(databaseOptionsFromConfig(config)),
    storage: createS3ObjectStorage({
      endpoint: config.S3_ENDPOINT,
      region: config.S3_REGION,
      bucket: config.S3_BUCKET,
      accessKeyId: config.S3_ACCESS_KEY_ID,
      secretAccessKey: config.S3_SECRET_ACCESS_KEY,
      forcePathStyle: config.S3_FORCE_PATH_STYLE,
    }),
    catalog: createMusicBrainzCatalog({
      userAgent: `VinylHound/0.1.0 (${config.APP_URL})`,
    }),
  };
}

export type ServerContext = ReturnType<typeof createServerContext>;

const serverGlobal = globalThis as typeof globalThis & {
  vinylHoundServerContext?: ServerContext;
};

export function getServerContext() {
  serverGlobal.vinylHoundServerContext ??= createServerContext();
  return serverGlobal.vinylHoundServerContext;
}
