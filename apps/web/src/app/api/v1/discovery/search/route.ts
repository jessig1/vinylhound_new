import {
  DiscoverySearchQuerySchema,
  DiscoverySearchResponseSchema,
} from "@vinylhound/contracts";

import { requireUserId } from "@/server/auth";
import { getServerContext } from "@/server/context";
import { requireDiscovery } from "@/server/discovery";
import { HttpError, jsonResponse, withRoute } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withRoute(
  "discovery.search",
  async (request, { requestId }) => {
    const url = new URL(request.url);
    const parsed = DiscoverySearchQuerySchema.safeParse({
      q: url.searchParams.get("q"),
      type: url.searchParams.get("type") ?? undefined,
      limit: url.searchParams.get("limit") ?? undefined,
    });
    if (!parsed.success) {
      throw new HttpError(
        400,
        "invalid_discovery_query",
        "A search needs a q of 1-200 characters; type must be all, artist, album, or track.",
      );
    }

    const context = getServerContext();
    await requireUserId(context);
    const results = await requireDiscovery(context).search({
      query: parsed.data.q,
      type: parsed.data.type,
      limit: parsed.data.limit,
    });

    const response = jsonResponse(
      DiscoverySearchResponseSchema.parse({
        ...results,
        query: parsed.data.q,
        type: parsed.data.type,
      }),
      200,
      requestId,
    );
    response.headers.set("cache-control", "private, max-age=300");
    return response;
  },
);
