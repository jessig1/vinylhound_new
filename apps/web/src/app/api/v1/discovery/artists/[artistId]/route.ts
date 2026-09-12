import { DiscoveryArtistDetailResponseSchema } from "@vinylhound/contracts";

import { requireUserId } from "@/server/auth";
import { getServerContext } from "@/server/context";
import { requireDiscovery } from "@/server/discovery";
import { jsonResponse, withRoute } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withRoute(
  "discovery.artists.details",
  async (
    _request,
    { requestId },
    route: { params: Promise<{ artistId: string }> },
  ) => {
    const { artistId } = await route.params;

    const context = getServerContext();
    await requireUserId(context);
    // A malformed Spotify ID is answered as not_found by the adapter rather
    // than as a 400, because an unknown ID and an unparseable one are the
    // same outcome to the caller: no such artist.
    const { artist, albums } =
      await requireDiscovery(context).getArtist(artistId);

    const response = jsonResponse(
      DiscoveryArtistDetailResponseSchema.parse({ artist, albums }),
      200,
      requestId,
    );
    response.headers.set("cache-control", "private, max-age=300");
    return response;
  },
);
