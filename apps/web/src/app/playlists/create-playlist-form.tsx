"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import { PLAYLIST_NAME_MAX_LENGTH } from "@vinylhound/contracts";
import type { PlaylistDetail } from "@vinylhound/contracts";

import { Icon } from "../ui";

/**
 * `POST /playlists` is idempotent by name: creating a playlist that already
 * exists opens it rather than making a second one, so the form navigates to
 * whichever playlist the server answered with.
 */
export function CreatePlaylistForm() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = name.trim();
    if (pending || !trimmed) return;
    setPending(true);
    setError(null);
    try {
      const response = await fetch("/api/v1/playlists", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: trimmed }),
      });
      const body = (await response.json()) as {
        error?: { message?: string };
        playlist?: PlaylistDetail;
      };
      if (!response.ok || !body.playlist) {
        throw new Error(
          body.error?.message ?? "The playlist could not be created.",
        );
      }
      router.push(`/playlists/${body.playlist.id}`);
      router.refresh();
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Something went wrong.",
      );
      setPending(false);
    }
  }

  return (
    <form className="create-playlist-form" onSubmit={create}>
      <label className="field field--wide">
        <span>Playlist name</span>
        <input
          autoComplete="off"
          disabled={pending}
          maxLength={PLAYLIST_NAME_MAX_LENGTH}
          onChange={(event) => setName(event.target.value)}
          placeholder="Sunday morning, road trip, lend to Sam…"
          value={name}
        />
      </label>
      <button
        className="primary-button"
        disabled={pending || !name.trim()}
        type="submit"
      >
        <Icon name="playlist" size={17} />
        {pending ? "Creating…" : "Create playlist"}
      </button>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
    </form>
  );
}
