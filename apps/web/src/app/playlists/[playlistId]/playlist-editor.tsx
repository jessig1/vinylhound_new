"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { PLAYLIST_NAME_MAX_LENGTH } from "@vinylhound/contracts";
import type { PlaylistDetail } from "@vinylhound/contracts";

import { CoverArt } from "../../cover-art";
import { toneForId } from "../../library-album-card";
import { Icon } from "../../ui";

type ErrorBody = { error?: { message?: string } };

/**
 * Rename, reorder, remove entries, and delete. Every reorder sends the
 * complete entry order; the server refuses a stale one (an entry added or
 * removed from another device since this page loaded) with 409, and the
 * editor reloads the playlist instead of guessing at a merge.
 */
export function PlaylistEditor({
  playlist: initialPlaylist,
}: {
  playlist: PlaylistDetail;
}) {
  const router = useRouter();
  const [playlist, setPlaylist] = useState(initialPlaylist);
  const [nameDraft, setNameDraft] = useState(initialPlaylist.name);
  const [pending, setPending] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const nameChanged = nameDraft.trim() !== playlist.name;

  async function reload() {
    const response = await fetch(`/api/v1/playlists/${playlist.id}`);
    if (response.ok) {
      const body = (await response.json()) as { playlist: PlaylistDetail };
      setPlaylist(body.playlist);
      setNameDraft(body.playlist.name);
    }
  }

  async function patch(
    body: { name?: string; entryIds?: string[] },
    failure: string,
  ) {
    if (pending) return;
    setPending(true);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch(`/api/v1/playlists/${playlist.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const result = (await response.json()) as ErrorBody & {
        playlist?: PlaylistDetail;
      };
      if (!response.ok || !result.playlist) {
        if (response.status === 409 && body.entryIds) {
          // Someone changed this playlist elsewhere; show the truth.
          await reload();
        }
        throw new Error(result.error?.message ?? failure);
      }
      setPlaylist(result.playlist);
      setNameDraft(result.playlist.name);
      if (body.name !== undefined) setNotice("Playlist renamed.");
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : failure);
    } finally {
      setPending(false);
    }
  }

  function rename(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = nameDraft.trim();
    if (!trimmed || !nameChanged) return;
    void patch({ name: trimmed }, "The playlist could not be renamed.");
  }

  function move(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= playlist.entries.length) return;
    const entryIds = playlist.entries.map((entry) => entry.id);
    const [moved] = entryIds.splice(index, 1);
    entryIds.splice(target, 0, moved!);
    void patch({ entryIds }, "The order could not be saved.");
  }

  async function remove(entryId: string) {
    if (pending) return;
    setPending(true);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch(
        `/api/v1/playlists/${playlist.id}/entries/${entryId}`,
        { method: "DELETE" },
      );
      const result = (await response.json()) as ErrorBody;
      // Already gone is the state being asked for.
      if (!response.ok && response.status !== 404) {
        throw new Error(
          result.error?.message ?? "The record could not be removed.",
        );
      }
      setPlaylist((current) => ({
        ...current,
        entries: current.entries.filter((entry) => entry.id !== entryId),
      }));
      router.refresh();
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Something went wrong.",
      );
    } finally {
      setPending(false);
    }
  }

  async function deletePlaylist() {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      const response = await fetch(`/api/v1/playlists/${playlist.id}`, {
        method: "DELETE",
      });
      const result = (await response.json()) as ErrorBody;
      if (!response.ok && response.status !== 404) {
        throw new Error(
          result.error?.message ?? "The playlist could not be deleted.",
        );
      }
      router.push("/playlists");
      router.refresh();
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Something went wrong.",
      );
      setPending(false);
    }
  }

  const count = playlist.entries.length;

  return (
    <div className="playlist-editor">
      <header className="page-heading">
        <div>
          <p className="section-kicker">Playlist</p>
          <h1>{playlist.name}</h1>
          <p>
            {count === 1 ? "1 record" : `${count} records`} · playlists
            organize your saved music; they do not play it.
          </p>
        </div>
      </header>

      <section className="settings-card">
        <h2>Name</h2>
        <form className="playlist-rename" onSubmit={rename}>
          <label className="field field--wide">
            <span className="visually-hidden">Playlist name</span>
            <input
              aria-label="Playlist name"
              autoComplete="off"
              disabled={pending}
              maxLength={PLAYLIST_NAME_MAX_LENGTH}
              onChange={(event) => setNameDraft(event.target.value)}
              value={nameDraft}
            />
          </label>
          <button
            className="secondary-button"
            disabled={pending || !nameChanged || !nameDraft.trim()}
            type="submit"
          >
            {pending ? "Saving…" : "Rename"}
          </button>
        </form>
        <span aria-live="polite" className="notes-editor__status">
          {notice ?? ""}
        </span>
      </section>

      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}

      {playlist.entries.length ? (
        <ol className="playlist-entries" aria-label="Records in this playlist">
          {playlist.entries.map((entry, index) => {
            const { item } = entry;
            const wishlist = item.list === "wishlist";
            return (
              <li className="playlist-entry" key={entry.id}>
                <span className="playlist-entry__index">{index + 1}</span>
                <div className="playlist-entry__art">
                  <CoverArt
                    image={item.coverImage}
                    title={item.release.title}
                    tone={toneForId(item.id)}
                  />
                </div>
                <div className="playlist-entry__body">
                  <Link href={`/library/${item.id}`}>
                    <strong>{item.release.title}</strong>
                  </Link>
                  <span>{item.release.artist}</span>
                  <small>
                    <Icon name={wishlist ? "heart" : "collection"} size={12} />{" "}
                    {wishlist ? "Wishlist" : "Collection"}
                    {item.release.releaseYear
                      ? ` · ${item.release.releaseYear}`
                      : ""}
                  </small>
                </div>
                <div className="playlist-entry__actions">
                  <button
                    aria-label={`Move ${item.release.title} up`}
                    className="icon-button"
                    disabled={pending || index === 0}
                    onClick={() => move(index, -1)}
                    type="button"
                  >
                    <Icon name="chevronUp" size={18} />
                  </button>
                  <button
                    aria-label={`Move ${item.release.title} down`}
                    className="icon-button"
                    disabled={pending || index === playlist.entries.length - 1}
                    onClick={() => move(index, 1)}
                    type="button"
                  >
                    <Icon name="chevronDown" size={18} />
                  </button>
                  <button
                    aria-label={`Remove ${item.release.title} from this playlist`}
                    className="text-button"
                    disabled={pending}
                    onClick={() => remove(entry.id)}
                    type="button"
                  >
                    Remove
                  </button>
                </div>
              </li>
            );
          })}
        </ol>
      ) : (
        <section className="library-empty">
          <span className="upload-card__icon">
            <Icon name="playlist" size={27} />
          </span>
          <h2>This playlist is empty.</h2>
          <p>
            Open a saved record in your{" "}
            <Link className="text-link" href="/collection">
              collection
            </Link>{" "}
            or{" "}
            <Link className="text-link" href="/wishlist">
              wishlist
            </Link>{" "}
            and add it from there.
          </p>
        </section>
      )}

      <section className="settings-card settings-card--danger">
        <h2>Delete this playlist</h2>
        <p>
          Deleting a playlist removes only the list. The records in it stay
          in your collection and wishlist.
        </p>
        {confirmingDelete ? (
          <div className="library-item-actions__confirm">
            <p>
              Delete <strong>{playlist.name}</strong>?
            </p>
            <div className="library-item-actions__buttons">
              <button
                className="secondary-button"
                disabled={pending}
                onClick={deletePlaylist}
                type="button"
              >
                {pending ? "Deleting…" : "Yes, delete it"}
              </button>
              <button
                className="text-button"
                disabled={pending}
                onClick={() => setConfirmingDelete(false)}
                type="button"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <button
            className="text-button text-button--danger"
            disabled={pending}
            onClick={() => setConfirmingDelete(true)}
            type="button"
          >
            Delete playlist
          </button>
        )}
      </section>
    </div>
  );
}
