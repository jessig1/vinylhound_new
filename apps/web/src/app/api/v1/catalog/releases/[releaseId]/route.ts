import { GetCatalogReleaseResponseSchema } from "@vinylhound/contracts";

import { requireUserId } from "@/server/auth";
import { getServerContext } from "@/server/context";
import { jsonResponse, parseUuid, withRoute } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withRoute(
  "catalog.releases.details",
  async (
    _request,
    { requestId },
    route: { params: Promise<{ releaseId: string }> },
  ) => {
    const { releaseId: rawReleaseId } = await route.params;
    const parsedReleaseId = parseUuid(rawReleaseId, "releaseId");

    const context = getServerContext();
    await requireUserId(context);
    const release = await context.catalog.getReleaseDetails(parsedReleaseId);
    const response = jsonResponse(
      GetCatalogReleaseResponseSchema.parse({ release }),
      200,
      requestId,
    );
    response.headers.set("cache-control", "private, max-age=300");
    return response;
  },
);
