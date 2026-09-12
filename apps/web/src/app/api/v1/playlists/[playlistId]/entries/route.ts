import {
  AddPlaylistEntrySchema,
  GetPlaylistResponseSchema,
} from "@vinylhound/contracts";
import { addPlaylistEntry } from "@vinylhound/database";

import { requireUserId } from "@/server/auth";
import { getServerContext } from "@/server/context";
import { jsonResponse, parseJson, parseUuid, withRoute } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Appends one of the user's saved records to the end of the playlist. A
 * playlist holds each saved release at most once, so a repeat add returns
 * the unchanged playlist with `200` instead of a duplicate entry; a record
 * the user does not own is `404`, never revealed as someone else's.
 */
export const POST = withRoute(
  "playlists.entries.add",
  async (
    request,
    { requestId },
    route: { params: Promise<{ playlistId: string }> },
  ) => {
    const { playlistId: rawPlaylistId } = await route.params;
    const playlistId = parseUuid(rawPlaylistId, "playlistId");
    const parsed = await parseJson(request, AddPlaylistEntrySchema);
    const context = getServerContext();
    const userId = await requireUserId(context);
    const { playlist, created } = await addPlaylistEntry(context.database.db, {
      userId,
      playlistId,
      libraryItemId: parsed.libraryItemId,
    });
    const response = jsonResponse(
      GetPlaylistResponseSchema.parse({ playlist }),
      created ? 201 : 200,
      requestId,
    );
    response.headers.set("cache-control", "no-store");
    return response;
  },
);
