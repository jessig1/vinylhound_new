"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";

import type { DiscoveryAlbum, DiscoveryArtist } from "@vinylhound/contracts";

import { Icon } from "../../../ui";
import { DiscoveryArt } from "../../discovery-art";
import {
  DiscoveryUnavailableError,
  fetchDiscoveryArtist,
} from "../../discovery-client";

export default function DiscoverArtistPage() {
  const params = useParams<{ artistId: string }>();
  const artistId = params.artistId;

  const [artist, setArtist] = useState<DiscoveryArtist | null>(null);
  const [albums, setAlbums] = useState<DiscoveryAlbum[]>([]);
  const [pending, setPending] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setPending(true);
    setError(null);

    fetchDiscoveryArtist(artistId, { signal: controller.signal })
      .then((result) => {
        if (controller.signal.aborted) return;
        setArtist(result.artist);
        setAlbums(result.albums);
      })
      .catch((caught: unknown) => {
        if (controller.signal.aborted) return;
        setError(
          caught instanceof DiscoveryUnavailableError
            ? "Discovery isn't set up on this deployment."
            : caught instanceof Error
              ? caught.message
              : "That artist could not be loaded.",
        );
      })
      .finally(() => {
        if (!controller.signal.aborted) setPending(false);
      });

    return () => controller.abort();
  }, [artistId]);

  const groups = groupByType(albums);

  return (
    <main className="content-page discover-page">
      <Link className="back-link" href="/discover">
        <Icon name="arrowLeft" size={16} /> Back to search
      </Link>

      {pending ? (
        <p className="field-help" role="status">
          Loading artist…
        </p>
      ) : null}
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}

      {artist ? (
        <>
          <header className="discover-artist-header">
            <DiscoveryArt
              id={artist.id}
              shape="circle"
              title={artist.name}
              url={artist.imageUrl}
            />
            <div>
              <p className="section-kicker">Artist</p>
              <h1>{artist.name}</h1>
              {artist.genres.length ? (
                <p className="field-help">{artist.genres.join(" · ")}</p>
              ) : null}
              <p className="field-help">
                <a href={artist.externalUrl} rel="noreferrer" target="_blank">
                  View on Spotify
                </a>
              </p>
            </div>
          </header>

          {groups.map((group) => (
            <section
              aria-label={group.title}
              className="discover-group"
              key={group.title}
            >
              <div className="review-section-heading">
                <div>
                  <p className="section-kicker">Discography</p>
                  <h2>{group.title}</h2>
                </div>
                <p className="field-help">
                  {group.albums.length === 1
                    ? "1 release"
                    : `${group.albums.length} releases`}
                </p>
              </div>
              <div className="discovery-grid">
                {group.albums.map((album) => (
                  <Link
                    className="discovery-card"
                    href={`/discover/albums/${album.id}`}
                    key={album.id}
                  >
                    <DiscoveryArt
                      id={album.id}
                      title={album.title}
                      url={album.coverUrl}
                    />
                    <span className="discovery-card__body">
                      <strong>{album.title}</strong>
                      <small className="discovery-card__meta">
                        {[
                          album.releaseYear?.toString(),
                          album.totalTracks
                            ? `${album.totalTracks} tracks`
                            : null,
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </small>
                    </span>
                  </Link>
                ))}
              </div>
            </section>
          ))}

          {!albums.length && !pending ? (
            <p className="empty-candidate-copy">
              Spotify lists no releases for this artist.
            </p>
          ) : null}
        </>
      ) : null}
    </main>
  );
}

/**
 * Albums, then singles and EPs, then compilations — the order a discography
 * is normally read in, rather than one undifferentiated list.
 */
function groupByType(albums: DiscoveryAlbum[]) {
  const order = [
    { type: "album" as const, title: "Albums" },
    { type: "single" as const, title: "Singles and EPs" },
    { type: "compilation" as const, title: "Compilations" },
  ];
  return order
    .map(({ type, title }) => ({
      title,
      albums: albums.filter((album) => album.albumType === type),
    }))
    .filter((group) => group.albums.length > 0);
}
