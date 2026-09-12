import {
  DeletePlaylistResponseSchema,
  GetPlaylistResponseSchema,
  UpdatePlaylistSchema,
} from "@vinylhound/contracts";
import {
  deletePlaylist,
  getPlaylistForUser,
  updatePlaylist,
} from "@vinylhound/database";

import { requireUserId } from "@/server/auth";
import { getServerContext } from "@/server/context";
import { jsonResponse, parseJson, parseUuid, withRoute } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type PlaylistRoute = { params: Promise<{ playlistId: string }> };

export const GET = withRoute(
  "playlists.get",
  async (_request, { requestId }, route: PlaylistRoute) => {
    const { playlistId: rawPlaylistId } = await route.params;
    const playlistId = parseUuid(rawPlaylistId, "playlistId");
    const context = getServerContext();
    const userId = await requireUserId(context);
    const playlist = await getPlaylistForUser(context.database.db, {
      userId,
      playlistId,
    });
    const response = jsonResponse(
      GetPlaylistResponseSchema.parse({ playlist }),
      200,
      requestId,
    );
    response.headers.set("cache-control", "no-store");
    return response;
  },
);

/**
 * Rename and/or reorder. `entryIds` must be the complete current entry set
 * in its new order; a stale set (an entry added or removed elsewhere since
 * the client last read the playlist) is rejected with `409 conflict` rather
 * than partially applied, and the client reloads.
 */
export const PATCH = withRoute(
  "playlists.update",
  async (request, { requestId }, route: PlaylistRoute) => {
    const { playlistId: rawPlaylistId } = await route.params;
    const playlistId = parseUuid(rawPlaylistId, "playlistId");
    const update = await parseJson(request, UpdatePlaylistSchema);
    const context = getServerContext();
    const userId = await requireUserId(context);
    const playlist = await updatePlaylist(context.database.db, {
      userId,
      playlistId,
      update,
    });
    const response = jsonResponse(
      GetPlaylistResponseSchema.parse({ playlist }),
      200,
      requestId,
    );
    response.headers.set("cache-control", "no-store");
    return response;
  },
);

export const DELETE = withRoute(
  "playlists.delete",
  async (_request, { requestId }, route: PlaylistRoute) => {
    const { playlistId: rawPlaylistId } = await route.params;
    const playlistId = parseUuid(rawPlaylistId, "playlistId");
    const context = getServerContext();
    const userId = await requireUserId(context);
    const result = await deletePlaylist(context.database.db, {
      userId,
      playlistId,
    });
    const response = jsonResponse(
      DeletePlaylistResponseSchema.parse(result),
      200,
      requestId,
    );
    response.headers.set("cache-control", "no-store");
    return response;
  },
);
