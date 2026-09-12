import { DiscoveryAlbumDetailResponseSchema } from "@vinylhound/contracts";

import { requireUserId } from "@/server/auth";
import { getServerContext } from "@/server/context";
import { requireDiscovery } from "@/server/discovery";
import { jsonResponse, withRoute } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withRoute(
  "discovery.albums.details",
  async (
    _request,
    { requestId },
    route: { params: Promise<{ albumId: string }> },
  ) => {
    const { albumId } = await route.params;

    const context = getServerContext();
    await requireUserId(context);
    const album = await requireDiscovery(context).getAlbum(albumId);

    const response = jsonResponse(
      DiscoveryAlbumDetailResponseSchema.parse({ album }),
      200,
      requestId,
    );
    response.headers.set("cache-control", "private, max-age=300");
    return response;
  },
);
