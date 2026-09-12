"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState } from "react";

import type {
  DiscoveryAlbum,
  DiscoveryArtist,
  DiscoverySearchResults,
  DiscoveryTrack,
} from "@vinylhound/contracts";

import { Icon } from "../ui";
import { DiscoveryArt } from "./discovery-art";
import {
  DiscoveryUnavailableError,
  formatDuration,
  searchDiscovery,
} from "./discovery-client";

const DEBOUNCE_MS = 350;
const MIN_QUERY_LENGTH = 2;

const emptyResults: DiscoverySearchResults = {
  artists: [],
  albums: [],
  tracks: [],
};

export default function DiscoverPage() {
  return (
    // useSearchParams needs a Suspense boundary to keep the route from
    // opting the whole page into client-side rendering at build time.
    <Suspense fallback={<DiscoverFallback />}>
      <DiscoverSearch />
    </Suspense>
  );
}

function DiscoverFallback() {
  return (
    <main className="content-page discover-page">
      <p className="field-help" role="status">
        Loading discovery…
      </p>
    </main>
  );
}

function DiscoverSearch() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const initialQuery = searchParams.get("q") ?? "";

  const [query, setQuery] = useState(initialQuery);
  const [results, setResults] = useState<DiscoverySearchResults>(emptyResults);
  const [searchedFor, setSearchedFor] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState<string | null>(null);

  // One controller per in-flight search. A newer keystroke aborts the older
  // request outright, so a slow response can never overwrite a newer one.
  const inFlight = useRef<AbortController | null>(null);

  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length < MIN_QUERY_LENGTH) {
      inFlight.current?.abort();
      inFlight.current = null;
      setResults(emptyResults);
      setSearchedFor(null);
      setPending(false);
      setError(null);
      return;
    }

    const timer = setTimeout(() => {
      inFlight.current?.abort();
      const controller = new AbortController();
      inFlight.current = controller;
      setPending(true);
      setError(null);

      searchDiscovery(trimmed, { limit: 12, signal: controller.signal })
        .then((response) => {
          if (controller.signal.aborted) return;
          setResults({
            artists: response.artists,
            albums: response.albums,
            tracks: response.tracks,
          });
          setSearchedFor(response.query);
          setUnavailable(null);
        })
        .catch((caught: unknown) => {
          if (controller.signal.aborted) return;
          setResults(emptyResults);
          setSearchedFor(trimmed);
          if (caught instanceof DiscoveryUnavailableError) {
            // The server's message distinguishes "no credentials configured"
            // from "Spotify refused these credentials", which need different
            // fixes; showing fixed copy here would send the reader after the
            // wrong one.
            setUnavailable(caught.message);
            setError(null);
            return;
          }
          setUnavailable(null);
          setError(
            caught instanceof Error
              ? caught.message
              : "The search could not be completed.",
          );
        })
        .finally(() => {
          if (!controller.signal.aborted) setPending(false);
        });
    }, DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [query]);

  // Keep the address bar in step so a search can be shared, bookmarked, and
  // returned to with the back button.
  useEffect(() => {
    const trimmed = query.trim();
    const current = searchParams.get("q") ?? "";
    if (trimmed === current) return;
    const timer = setTimeout(() => {
      router.replace(
        trimmed ? `/discover?q=${encodeURIComponent(trimmed)}` : "/discover",
        { scroll: false },
      );
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query, router, searchParams]);

  useEffect(() => () => inFlight.current?.abort(), []);

  const total =
    results.artists.length + results.albums.length + results.tracks.length;
  const showEmpty =
    searchedFor !== null && total === 0 && !pending && !error && !unavailable;

  return (
    <main className="content-page discover-page">
      <header className="page-heading">
        <div>
          <p className="section-kicker">Discovery</p>
          <h1>Find any record.</h1>
          <p>
            Search artists, albums, and tracks without scanning a sleeve. Save
            what you find to your collection or wishlist.
          </p>
        </div>
      </header>

      <form
        className="discover-search-form"
        onSubmit={(event) => event.preventDefault()}
        role="search"
      >
        <div className="discover-search-field">
          <Icon name="search" size={18} />
          <input
            aria-label="Search artists, albums, and tracks"
            autoComplete="off"
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Miles Davis, Kind of Blue, So What…"
            type="search"
            value={query}
          />
          {query ? (
            <button
              aria-label="Clear search"
              className="discover-search-clear"
              onClick={() => setQuery("")}
              type="button"
            >
              ✕
            </button>
          ) : null}
        </div>
        <p aria-live="polite" className="field-help">
          {pending
            ? "Searching…"
            : searchedFor && total
              ? `${total} results for “${searchedFor}”.`
              : query.trim().length > 0 &&
                  query.trim().length < MIN_QUERY_LENGTH
                ? "Keep typing to search."
                : " "}
        </p>
      </form>

      {unavailable ? (
        <p className="empty-candidate-copy">
          {unavailable} Scanning and your library work either way.
        </p>
      ) : null}
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      {showEmpty ? (
        <p className="empty-candidate-copy">
          Nothing found for “{searchedFor}”. Try a different spelling, or search
          the artist on its own.
        </p>
      ) : null}

      {results.artists.length ? (
        <ResultSection title="Artists">
          <div className="discovery-grid discovery-grid--artists">
            {results.artists.map((artist) => (
              <ArtistCard artist={artist} key={artist.id} />
            ))}
          </div>
        </ResultSection>
      ) : null}

      {results.albums.length ? (
        <ResultSection title="Albums">
          <div className="discovery-grid">
            {results.albums.map((album) => (
              <AlbumCard album={album} key={album.id} />
            ))}
          </div>
        </ResultSection>
      ) : null}

      {results.tracks.length ? (
        <ResultSection title="Tracks">
          <ul className="discovery-track-list">
            {results.tracks.map((track) => (
              <TrackRow key={track.id} track={track} />
            ))}
          </ul>
        </ResultSection>
      ) : null}
    </main>
  );
}

function ResultSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section aria-label={title} className="discover-group">
      <div className="review-section-heading">
        <div>
          <p className="section-kicker">Results</p>
          <h2>{title}</h2>
        </div>
      </div>
      {children}
    </section>
  );
}

function ArtistCard({ artist }: { artist: DiscoveryArtist }) {
  return (
    <Link className="discovery-card" href={`/discover/artists/${artist.id}`}>
      <DiscoveryArt
        id={artist.id}
        shape="circle"
        title={artist.name}
        url={artist.imageUrl}
      />
      <span className="discovery-card__body">
        <strong>{artist.name}</strong>
        <small>{artist.genres.slice(0, 2).join(", ") || "Artist"}</small>
      </span>
    </Link>
  );
}

function AlbumCard({ album }: { album: DiscoveryAlbum }) {
  return (
    <Link className="discovery-card" href={`/discover/albums/${album.id}`}>
      <DiscoveryArt id={album.id} title={album.title} url={album.coverUrl} />
      <span className="discovery-card__body">
        <strong>{album.title}</strong>
        <small>{album.artist}</small>
        <small className="discovery-card__meta">
          {[
            album.releaseYear?.toString(),
            album.albumType === "album" ? null : album.albumType,
          ]
            .filter(Boolean)
            .join(" · ")}
        </small>
      </span>
    </Link>
  );
}

function TrackRow({ track }: { track: DiscoveryTrack }) {
  const body = (
    <>
      <DiscoveryArt id={track.id} title={track.title} url={track.coverUrl} />
      <span className="discovery-card__body">
        <strong>{track.title}</strong>
        <small>{track.artist}</small>
        {track.albumTitle ? (
          <small className="discovery-card__meta">{track.albumTitle}</small>
        ) : null}
      </span>
      {track.durationMs ? (
        <span className="discovery-track-list__length">
          {formatDuration(track.durationMs)}
        </span>
      ) : null}
    </>
  );

  return (
    <li>
      {track.albumId ? (
        <Link
          className="discovery-card"
          href={`/discover/albums/${track.albumId}`}
        >
          {body}
        </Link>
      ) : (
        <span className="discovery-card discovery-card--static">{body}</span>
      )}
    </li>
  );
}
