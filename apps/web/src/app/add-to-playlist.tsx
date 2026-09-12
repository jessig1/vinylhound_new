"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import type { PlaylistDetail, PlaylistSummary } from "@vinylhound/contracts";

import { Icon } from "./ui";

type Membership = { playlistId: string; entryId: string };

/**
 * Adds a saved record to one of the user's playlists, and lists the
 * playlists that already hold it with a way out of each. Adding is
 * idempotent by identity on the server, so a double tap cannot create a
 * second entry.
 */
export function AddToPlaylist({
  itemId,
  playlists,
  memberships: initialMemberships,
}: {
  itemId: string;
  playlists: PlaylistSummary[];
  memberships: Membership[];
}) {
  const router = useRouter();
  const [memberships, setMemberships] = useState(initialMemberships);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const memberIds = new Set(memberships.map((entry) => entry.playlistId));
  const available = playlists.filter((playlist) => !memberIds.has(playlist.id));
  const [selected, setSelected] = useState(available[0]?.id ?? "");
  const selectedId = available.some((playlist) => playlist.id === selected)
    ? selected
    : (available[0]?.id ?? "");

  async function add() {
    if (pending || !selectedId) return;
    setPending(true);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch(`/api/v1/playlists/${selectedId}/entries`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ libraryItemId: itemId }),
      });
      const body = (await response.json()) as {
        error?: { message?: string };
        playlist?: PlaylistDetail;
      };
      if (!response.ok || !body.playlist) {
        throw new Error(
          body.error?.message ?? "The record could not be added.",
        );
      }
      const entry = body.playlist.entries.find(
        (candidate) => candidate.item.id === itemId,
      );
      if (entry) {
        setMemberships((current) => [
          ...current.filter((member) => member.playlistId !== selectedId),
          { playlistId: selectedId, entryId: entry.id },
        ]);
      }
      setNotice(`Added to ${body.playlist.name}.`);
      router.refresh();
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Something went wrong.",
      );
    } finally {
      setPending(false);
    }
  }

  async function remove(member: Membership) {
    if (pending) return;
    setPending(true);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch(
        `/api/v1/playlists/${member.playlistId}/entries/${member.entryId}`,
        { method: "DELETE" },
      );
      const body = (await response.json()) as { error?: { message?: string } };
      // A 404 means it is already gone, which is the state being asked for.
      if (!response.ok && response.status !== 404) {
        throw new Error(
          body.error?.message ?? "The record could not be removed.",
        );
      }
      setMemberships((current) =>
        current.filter((candidate) => candidate.entryId !== member.entryId),
      );
      router.refresh();
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Something went wrong.",
      );
    } finally {
      setPending(false);
    }
  }

  const nameOf = (playlistId: string) =>
    playlists.find((playlist) => playlist.id === playlistId)?.name ??
    "a playlist";

  return (
    <div className="add-to-playlist">
      {memberships.length ? (
        <ul className="playlist-membership" aria-label="In these playlists">
          {memberships.map((member) => (
            <li key={member.entryId}>
              <Link href={`/playlists/${member.playlistId}`}>
                <Icon name="playlist" size={15} />
                {nameOf(member.playlistId)}
              </Link>
              <button
                aria-label={`Remove from ${nameOf(member.playlistId)}`}
                className="text-button"
                disabled={pending}
                onClick={() => remove(member)}
                type="button"
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="field-help">This record is not in any playlist yet.</p>
      )}

      {playlists.length === 0 ? (
        <p className="field-help">
          <Link className="text-link" href="/playlists">
            Create your first playlist
          </Link>{" "}
          to start organizing your saved music.
        </p>
      ) : available.length ? (
        <div className="add-to-playlist__form">
          <label className="field">
            <span>Playlist</span>
            <select
              disabled={pending}
              onChange={(event) => setSelected(event.target.value)}
              value={selectedId}
            >
              {available.map((playlist) => (
                <option key={playlist.id} value={playlist.id}>
                  {playlist.name}
                </option>
              ))}
            </select>
          </label>
          <button
            className="secondary-button"
            disabled={pending || !selectedId}
            onClick={add}
            type="button"
          >
            <Icon name="playlist" size={17} />
            {pending ? "Adding…" : "Add to playlist"}
          </button>
        </div>
      ) : (
        <p className="field-help">
          This record is already in every playlist you have.
        </p>
      )}

      <span aria-live="polite" className="notes-editor__status">
        {notice ?? ""}
      </span>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
