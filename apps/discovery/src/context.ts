import type { DiscoveryServiceConfig } from "@vinylhound/config";
import {
  createMusicBrainzCatalog,
  createSpotifyDiscovery,
  type CatalogProvider,
  type DiscoveryProvider,
} from "@vinylhound/catalog";

export interface DiscoveryServiceContext {
  config: DiscoveryServiceConfig;
  catalog: CatalogProvider;
  /** Null whenever Spotify credentials are unset — see ADR-0019/ADR-0025. */
  discovery: DiscoveryProvider | null;
}

export function createDiscoveryServiceContext(
  config: DiscoveryServiceConfig,
): DiscoveryServiceContext {
  return {
    config,
    catalog: createMusicBrainzCatalog({
      userAgent: `VinylHound/0.1.0 (${config.APP_URL})`,
    }),
    discovery:
      config.SPOTIFY_CLIENT_ID && config.SPOTIFY_CLIENT_SECRET
        ? createSpotifyDiscovery({
            clientId: config.SPOTIFY_CLIENT_ID,
            clientSecret: config.SPOTIFY_CLIENT_SECRET,
          })
        : null,
  };
}
