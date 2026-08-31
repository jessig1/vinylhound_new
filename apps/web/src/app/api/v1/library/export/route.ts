import { LibraryQuerySchema } from "@vinylhound/contracts";
import { listLibraryItemsForUser } from "@vinylhound/database";

import { getServerContext } from "@/server/context";
import { createRequestId, errorResponse, HttpError } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CSV_COLUMNS = [
  "artist",
  "title",
  "releaseYear",
  "label",
  "format",
  "country",
  "list",
  "notes",
  "copyCount",
] as const;

export async function GET(request: Request) {
  const requestId = createRequestId();
  try {
    const searchParams = new URL(request.url).searchParams;
    const parsedQuery = LibraryQuerySchema.safeParse({
      list: searchParams.get("list"),
      q: searchParams.get("q") ?? undefined,
      sort: searchParams.get("sort") ?? undefined,
    });
    if (!parsedQuery.success) {
      throw new HttpError(
        400,
        "invalid_query",
        "The list query parameter must be collection or wishlist, and sort (if provided) must be recent, artist, or title.",
      );
    }
    const context = getServerContext();
    const result = await listLibraryItemsForUser(context.database.db, {
      userId: context.config.DEVELOPMENT_USER_ID,
      list: parsedQuery.data.list,
      query: parsedQuery.data.q,
      sort: parsedQuery.data.sort,
    });

    const rows = result.items.map((item) => [
      item.release.artist,
      item.release.title,
      item.release.releaseYear?.toString() ?? "",
      item.release.label ?? "",
      item.release.format ?? "",
      item.release.country ?? "",
      item.list,
      item.notes ?? "",
      item.copyCount.toString(),
    ]);
    const csv = [
      CSV_COLUMNS.join(","),
      ...rows.map((row) => row.map(csvEscape).join(",")),
    ].join("\r\n");

    return new Response(csv, {
      status: 200,
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="${parsedQuery.data.list}.csv"`,
        "cache-control": "no-store",
        "x-request-id": requestId,
      },
    });
  } catch (error) {
    return errorResponse(error, requestId);
  }
}

function csvEscape(value: string) {
  if (!/[",\r\n]/.test(value)) return value;
  return `"${value.replace(/"/g, '""')}"`;
}
