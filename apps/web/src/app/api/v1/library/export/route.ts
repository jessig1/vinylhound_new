import { LibraryQuerySchema } from "@vinylhound/contracts";
import { iterateLibraryItemsForUser } from "@vinylhound/database";

import { requireUserId } from "@/server/auth";
import { getServerContext } from "@/server/context";
import { HttpError, withRoute } from "@/server/http";
import { libraryCsvHeader, libraryCsvLine } from "@/server/library-csv";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Downloads every record the same `list`/`q`/`sort` read would return, not
 * only its first page (ADR-0023): the response body is a stream that pulls
 * one page at a time from the repository and writes it out as CSV, so a
 * library of any size exports without being held in memory. `cursor` and
 * `limit` are accepted for symmetry with `GET /library` but ignored — an
 * export is always complete.
 */
export const GET = withRoute(
  "library.export",
  async (request, { requestId }) => {
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
    const userId = await requireUserId(context);
    const pages = iterateLibraryItemsForUser(context.database.db, {
      userId,
      list: parsedQuery.data.list,
      query: parsedQuery.data.q,
      sort: parsedQuery.data.sort,
    });
    // The first page is read before the response starts so a database
    // failure still surfaces as an error status rather than an empty file.
    const first = await pages.next();

    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(libraryCsvHeader()));
        if (!first.done) {
          controller.enqueue(
            encoder.encode(first.value.map(libraryCsvLine).join("")),
          );
        } else {
          controller.close();
        }
      },
      async pull(controller) {
        try {
          const page = await pages.next();
          if (page.done) {
            controller.close();
            return;
          }
          controller.enqueue(
            encoder.encode(page.value.map(libraryCsvLine).join("")),
          );
        } catch (error) {
          // The status line is already sent; the download ends short and the
          // log says why.
          console.error(
            `[web] library export interrupted; requestId=${requestId}`,
            { message: error instanceof Error ? error.message : String(error) },
          );
          controller.error(error);
        }
      },
      async cancel() {
        await pages.return();
      },
    });

    return new Response(body, {
      status: 200,
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="${parsedQuery.data.list}.csv"`,
        "cache-control": "no-store",
        "x-request-id": requestId,
      },
    });
  },
);
