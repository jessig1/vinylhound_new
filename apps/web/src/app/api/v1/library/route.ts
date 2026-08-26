import {
  GetLibraryResponseSchema,
  LibraryListSchema,
} from "@vinylhound/contracts";
import { listLibraryItemsForUser } from "@vinylhound/database";

import { getServerContext } from "@/server/context";
import {
  createRequestId,
  errorResponse,
  HttpError,
  jsonResponse,
} from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const requestId = createRequestId();
  try {
    const parsedList = LibraryListSchema.safeParse(
      new URL(request.url).searchParams.get("list"),
    );
    if (!parsedList.success) {
      throw new HttpError(
        400,
        "invalid_list",
        "The list query parameter must be collection or wishlist.",
      );
    }
    const context = getServerContext();
    const result = await listLibraryItemsForUser(context.database.db, {
      userId: context.config.DEVELOPMENT_USER_ID,
      list: parsedList.data,
    });
    const response = jsonResponse(
      GetLibraryResponseSchema.parse(result),
      200,
      requestId,
    );
    response.headers.set("cache-control", "no-store");
    return response;
  } catch (error) {
    return errorResponse(error, requestId);
  }
}
