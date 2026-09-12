import { DeletePlaylistEntryResponseSchema } from "@vinylhound/contracts";
import { removePlaylistEntry } from "@vinylhound/database";

import { requireUserId } from "@/server/auth";
import { getServerContext } from "@/server/context";
import { jsonResponse, parseUuid, withRoute } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const DELETE = withRoute(
  "playlists.entries.remove",
  async (
    _request,
    { requestId },
    route: { params: Promise<{ playlistId: string; entryId: string }> },
  ) => {
    const { playlistId: rawPlaylistId, entryId: rawEntryId } =
      await route.params;
    const playlistId = parseUuid(rawPlaylistId, "playlistId");
    const entryId = parseUuid(rawEntryId, "entryId");
    const context = getServerContext();
    const userId = await requireUserId(context);
    const result = await removePlaylistEntry(context.database.db, {
      userId,
      playlistId,
      entryId,
    });
    const response = jsonResponse(
      DeletePlaylistEntryResponseSchema.parse(result),
      200,
      requestId,
    );
    response.headers.set("cache-control", "no-store");
    return response;
  },
);
