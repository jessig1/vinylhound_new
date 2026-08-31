import { z } from "zod";

import { SearchCatalogReleasesResponseSchema } from "@vinylhound/contracts";

import { requireUserId } from "@/server/auth";
import { getServerContext } from "@/server/context";
import {
  createRequestId,
  errorResponse,
  HttpError,
  jsonResponse,
} from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SearchQuerySchema = z.object({
  artist: z.string().trim().min(1).max(255),
  title: z.string().trim().min(1).max(255),
  limit: z.coerce.number().int().min(1).max(25).default(10),
});

export async function GET(request: Request) {
  const requestId = createRequestId();
  try {
    const url = new URL(request.url);
    const parsed = SearchQuerySchema.safeParse({
      artist: url.searchParams.get("artist"),
      title: url.searchParams.get("title"),
      limit: url.searchParams.get("limit") ?? undefined,
    });
    if (!parsed.success) {
      throw new HttpError(
        400,
        "invalid_catalog_query",
        "Artist and title are required catalog search parameters.",
      );
    }

    const context = getServerContext();
    await requireUserId(context);
    const results = await context.catalog.searchReleases(parsed.data);
    const response = jsonResponse(
      SearchCatalogReleasesResponseSchema.parse({ results }),
      200,
      requestId,
    );
    response.headers.set("cache-control", "private, max-age=300");
    return response;
  } catch (error) {
    return errorResponse(error, requestId);
  }
}
