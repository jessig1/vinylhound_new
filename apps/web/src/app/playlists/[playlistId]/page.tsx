import Link from "next/link";
import { notFound } from "next/navigation";

import { DatabaseCommandError, getPlaylistForUser } from "@vinylhound/database";

import { requireUserId } from "@/server/auth";
import { getServerContext } from "@/server/context";

import { Icon } from "../../ui";

import { PlaylistEditor } from "./playlist-editor";

export const dynamic = "force-dynamic";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function PlaylistPage({
  params,
}: {
  params: Promise<{ playlistId: string }>;
}) {
  const { playlistId } = await params;
  if (!UUID_PATTERN.test(playlistId)) notFound();

  const context = getServerContext();
  const userId = await requireUserId(context);
  const playlist = await getPlaylistForUser(context.database.db, {
    userId,
    playlistId,
  }).catch((error: unknown) => {
    if (error instanceof DatabaseCommandError && error.code === "not_found") {
      notFound();
    }
    throw error;
  });

  return (
    <main className="content-page library-page playlist-page">
      <Link className="back-link" href="/playlists">
        <Icon name="arrowLeft" size={17} />
        Back to playlists
      </Link>
      <PlaylistEditor playlist={playlist} />
    </main>
  );
}
