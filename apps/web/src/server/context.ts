import path from "node:path";

import { loadEnvConfig } from "@next/env";

import { loadDevelopmentWebConfig } from "@vinylhound/config";
import {
  createMusicBrainzCatalog,
  createRemoteCatalogClient,
  createRemoteDiscoveryClient,
  createSpotifyDiscovery,
} from "@vinylhound/catalog";
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

  // Both unset (the default, including every local/CI run): construct the
  // MusicBrainz/Spotify adapters in process, exactly as before ADR-0025. Both
  // set (staging/production per ADR-0025's tier scope): call the standalone
  // apps/discovery service instead, over an authenticated internal API
  // (P4.1 Task 2) rather than duplicating provider credentials into a second
  // process's config.
  const discoveryService =
    config.DISCOVERY_SERVICE_URL && config.DISCOVERY_SERVICE_SHARED_SECRET
      ? {
          baseUrl: config.DISCOVERY_SERVICE_URL,
          sharedSecret: config.DISCOVERY_SERVICE_SHARED_SECRET,
        }
      : null;

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
    catalog: discoveryService
      ? createRemoteCatalogClient(discoveryService)
      : createMusicBrainzCatalog({
          userAgent: `VinylHound/0.1.0 (${config.APP_URL})`,
        }),
    // Null whenever discovery has no route to Spotify at all — locally, that
    // is unset Spotify credentials; behind the discovery service, the remote
    // client is still constructed (it has no credentials of its own to
    // check), and an actual call surfaces the service's own 503 as the same
    // DiscoveryProviderError("not_configured", ...) requireDiscovery expects.
    // Discovery is an additive browse surface either way, so the app boots
    // and scanning keeps working without it; the routes answer 503 and
    // /discover explains itself (ADR-0019).
    discovery: discoveryService
      ? createRemoteDiscoveryClient(discoveryService)
      : config.SPOTIFY_CLIENT_ID && config.SPOTIFY_CLIENT_SECRET
        ? createSpotifyDiscovery({
            clientId: config.SPOTIFY_CLIENT_ID,
            clientSecret: config.SPOTIFY_CLIENT_SECRET,
          })
        : null,
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
