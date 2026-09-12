"use client";

import { useState } from "react";

import {
  PlaceLibraryReleaseResponseSchema,
  type DiscoveryAlbumDetail,
  type LibraryList,
} from "@vinylhound/contracts";

import { Icon } from "../ui";

/**
 * Builds the saved record from a Spotify album.
 *
 * Every field Spotify cannot answer is sent as null rather than guessed:
 * catalog number, country, format, packaging and release status have no
 * Spotify equivalent, and inventing them would turn a streaming lookup into a
 * pressing claim. The catalog reference carries `releaseId: null` for the same
 * reason — it names the album concept only (ADR-0019).
 */
function toPlacement(album: DiscoveryAlbumDetail, list: LibraryList) {
  return {
    artist: album.artist,
    title: album.title,
    releaseYear: album.releaseYear,
    label: album.label,
    catalogNumber: null,
    barcode: album.barcode,
    releaseDate: album.releaseDate,
    country: null,
    format: null,
    packaging: null,
    releaseStatus: null,
    catalogReference: {
      provider: "spotify" as const,
      releaseGroupId: album.id,
      releaseId: null,
      sourceUrl: album.externalUrl,
      // Replaced server-side; the recorded provenance time must not come
      // from an untrusted clock.
      fetchedAt: new Date().toISOString(),
    },
    list,
    notes: null,
    copy: null,
  };
}

export function SaveToLibrary({ album }: { album: DiscoveryAlbumDetail }) {
  const [pending, setPending] = useState<LibraryList | null>(null);
  const [saved, setSaved] = useState<LibraryList | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function save(list: LibraryList) {
    if (pending) return;
    setPending(list);
    setError(null);
    try {
      const response = await fetch("/api/v1/library", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(toPlacement(album, list)),
      });
      const body = (await response.json().catch(() => ({}))) as {
        error?: { message?: string };
      };
      if (!response.ok) {
        throw new Error(
          body.error?.message ?? "The record could not be saved.",
        );
      }
      const parsed = PlaceLibraryReleaseResponseSchema.parse(body);
      setSaved(parsed.libraryItem.list);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "The record could not be saved.",
      );
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="discover-save">
      <div className="discover-save__actions">
        <button
          className="primary-button"
          disabled={pending !== null}
          onClick={() => save("collection")}
          type="button"
        >
          <Icon name="collection" size={18} />
          {pending === "collection" ? "Saving…" : "Add to collection"}
        </button>
        <button
          className="secondary-button"
          disabled={pending !== null}
          onClick={() => save("wishlist")}
          type="button"
        >
          <Icon name="heart" size={18} />
          {pending === "wishlist" ? "Saving…" : "Add to wishlist"}
        </button>
      </div>

      {saved ? (
        <p className="form-success" role="status">
          <Icon name="check" size={16} /> Saved to your{" "}
          {saved === "collection" ? "collection" : "wishlist"}. Adding it again
          won&apos;t create a duplicate.
        </p>
      ) : null}
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}

      <p className="pressing-note">
        <Icon name="info" size={16} /> Spotify identifies the album, never the
        pressing. This saves the record with no catalog number, country, or
        format — scan the sleeve, or edit the copy afterwards, to pin down the
        edition you actually own.
      </p>
    </div>
  );
}
