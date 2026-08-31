import path from "node:path";

import { loadEnvConfig } from "@next/env";

import { loadDevelopmentWebConfig } from "@vinylhound/config";
import { createMusicBrainzCatalog } from "@vinylhound/catalog";
import { createDatabase } from "@vinylhound/database";
import { createS3ObjectStorage } from "@vinylhound/storage";

loadEnvConfig(path.resolve(process.cwd(), "../.."));

function createServerContext() {
  const config = loadDevelopmentWebConfig();

  return {
    config,
    database: createDatabase({ connectionString: config.DATABASE_URL }),
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
