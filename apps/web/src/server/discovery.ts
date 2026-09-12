import { DiscoveryProviderError } from "@vinylhound/catalog";

import type { ServerContext } from "./context";

/**
 * Discovery is optional: a deployment with no Spotify credentials still
 * scans, reviews, and manages a library. Routes that need it say so with a
 * 503 rather than a 500, so the UI can distinguish "not set up here" from
 * "broken".
 */
export function requireDiscovery(context: ServerContext) {
  if (!context.discovery) {
    throw new DiscoveryProviderError(
      "not_configured",
      false,
      "Discovery is not configured for this deployment.",
    );
  }
  return context.discovery;
}
