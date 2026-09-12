import Link from "next/link";

import { listPlaylistsForUser } from "@vinylhound/database";

import { requireUserId } from "@/server/auth";
import { getServerContext } from "@/server/context";

import { SavedMusicNav } from "../saved-music-nav";
import { Icon } from "../ui";

import { CreatePlaylistForm } from "./create-playlist-form";

export const dynamic = "force-dynamic";

export default async function PlaylistsPage() {
  const context = getServerContext();
  const userId = await requireUserId(context);
  const { playlists } = await listPlaylistsForUser(context.database.db, {
    userId,
  });

  return (
    <main className="content-page library-page">
      <header className="page-heading">
        <div>
          <p className="section-kicker">Saved music</p>
          <h1>Your playlists</h1>
          <p>
            Ordered lists of records you have saved. Playlists organize your
            music; they do not play it.
          </p>
        </div>
      </header>

      <SavedMusicNav current="playlists" />

      <section className="settings-card">
        <h2>New playlist</h2>
        <CreatePlaylistForm />
      </section>

      {playlists.length ? (
        <ul className="playlist-list" aria-label="Your playlists">
          {playlists.map((playlist) => (
            <li key={playlist.id}>
              <Link className="playlist-card" href={`/playlists/${playlist.id}`}>
                <span className="playlist-card__icon">
                  <Icon name="playlist" size={20} />
                </span>
                <span className="playlist-card__body">
                  <strong>{playlist.name}</strong>
                  <small>
                    {playlist.entryCount === 1
                      ? "1 record"
                      : `${playlist.entryCount} records`}{" "}
                    · updated{" "}
                    {new Date(playlist.updatedAt).toLocaleDateString()}
                  </small>
                </span>
                <Icon name="chevronRight" size={18} />
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <section className="library-empty">
          <span className="upload-card__icon">
            <Icon name="playlist" size={27} />
          </span>
          <h2>No playlists yet.</h2>
          <p>
            Name one above, then add records to it from any saved record’s
            page.
          </p>
        </section>
      )}
    </main>
  );
}
