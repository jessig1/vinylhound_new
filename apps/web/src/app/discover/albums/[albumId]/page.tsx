"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";

import type { DiscoveryAlbumDetail } from "@vinylhound/contracts";

import { Icon } from "../../../ui";
import { DiscoveryArt } from "../../discovery-art";
import {
  DiscoveryUnavailableError,
  fetchDiscoveryAlbum,
  formatDuration,
} from "../../discovery-client";
import { SaveToLibrary } from "../../save-to-library";

export default function DiscoverAlbumPage() {
  const params = useParams<{ albumId: string }>();
  const albumId = params.albumId;

  const [album, setAlbum] = useState<DiscoveryAlbumDetail | null>(null);
  const [pending, setPending] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setPending(true);
    setError(null);

    fetchDiscoveryAlbum(albumId, { signal: controller.signal })
      .then((result) => {
        if (!controller.signal.aborted) setAlbum(result);
      })
      .catch((caught: unknown) => {
        if (controller.signal.aborted) return;
        setError(
          caught instanceof DiscoveryUnavailableError
            ? "Discovery isn't set up on this deployment."
            : caught instanceof Error
              ? caught.message
              : "That album could not be loaded.",
        );
      })
      .finally(() => {
        if (!controller.signal.aborted) setPending(false);
      });

    return () => controller.abort();
  }, [albumId]);

  return (
    <main className="content-page discover-page">
      <Link className="back-link" href="/discover">
        <Icon name="arrowLeft" size={16} /> Back to search
      </Link>

      {pending ? (
        <p className="field-help" role="status">
          Loading album…
        </p>
      ) : null}
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}

      {album ? (
        <>
          <header className="discover-album-header">
            <DiscoveryArt
              id={album.id}
              title={album.title}
              url={album.coverUrl}
            />
            <div>
              <p className="section-kicker">
                {album.albumType === "album" ? "Album" : album.albumType}
              </p>
              <h1>{album.title}</h1>
              <p className="discover-album-header__artist">
                {album.artistIds.length === 1 && album.artistIds[0] ? (
                  <Link href={`/discover/artists/${album.artistIds[0]}`}>
                    {album.artist}
                  </Link>
                ) : (
                  album.artist
                )}
              </p>
              <p className="field-help">
                {[
                  album.releaseDate,
                  album.totalTracks ? `${album.totalTracks} tracks` : null,
                  album.label,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
            </div>
          </header>

          <section className="discover-detail" aria-label="Save this record">
            <SaveToLibrary album={album} />
          </section>

          {album.tracks.length ? (
            <section className="discover-group" aria-label="Tracklist">
              <div className="review-section-heading">
                <div>
                  <p className="section-kicker">Tracklist</p>
                  <h2>{album.tracks.length} tracks</h2>
                </div>
              </div>
              <div className="discover-tracklist">
                <ol>
                  {album.tracks.map((track) => (
                    <li key={track.id}>
                      <span className="discover-tracklist__position">
                        {track.trackNumber ?? "—"}
                      </span>
                      <span className="discover-tracklist__title">
                        {track.title}
                      </span>
                      <span className="discover-tracklist__length">
                        {track.durationMs
                          ? formatDuration(track.durationMs)
                          : ""}
                      </span>
                    </li>
                  ))}
                </ol>
              </div>
            </section>
          ) : null}

          <section className="discover-detail" aria-label="Album details">
            <dl className="discover-detail__facts">
              <Fact label="Released" value={album.releaseDate} />
              <Fact label="Label" value={album.label} />
              <Fact label="Barcode (UPC)" value={album.barcode} />
              <Fact label="Genres" value={album.genres.join(", ") || null} />
            </dl>
            <p className="field-help">
              Source: Spotify ·{" "}
              <a href={album.externalUrl} rel="noreferrer" target="_blank">
                Open on Spotify
              </a>
            </p>
          </section>
        </>
      ) : null}
    </main>
  );
}

function Fact({ label, value }: { label: string; value: string | null }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value ?? "Not listed"}</dd>
    </div>
  );
}
