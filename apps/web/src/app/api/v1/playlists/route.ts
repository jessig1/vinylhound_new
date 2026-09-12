import {
  CreatePlaylistSchema,
  GetPlaylistResponseSchema,
  ListPlaylistsResponseSchema,
} from "@vinylhound/contracts";
import { createPlaylist, listPlaylistsForUser } from "@vinylhound/database";

import { requireUserId } from "@/server/auth";
import { getServerContext } from "@/server/context";
import { jsonResponse, parseJson, withRoute } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withRoute(
  "playlists.list",
  async (_request, { requestId }) => {
    const context = getServerContext();
    const userId = await requireUserId(context);
    const result = await listPlaylistsForUser(context.database.db, { userId });
    const response = jsonResponse(
      ListPlaylistsResponseSchema.parse(result),
      200,
      requestId,
    );
    response.headers.set("cache-control", "no-store");
    return response;
  },
);

/**
 * Creates a playlist, or returns the existing one when the user already has
 * a playlist with that name (compared case- and whitespace-insensitively).
 * Idempotent by identity like `POST /library`, so no `Idempotency-Key` is
 * required; `201` on creation, `200` on convergence.
 */
export const POST = withRoute(
  "playlists.create",
  async (request, { requestId }) => {
    const parsed = await parseJson(request, CreatePlaylistSchema);
    const context = getServerContext();
    const userId = await requireUserId(context);
    const { playlist, created } = await createPlaylist(context.database.db, {
      userId,
      name: parsed.name,
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
