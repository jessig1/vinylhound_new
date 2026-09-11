"use client";

import type { FormEvent } from "react";
import { useState } from "react";

import {
  GetCatalogReleaseResponseSchema,
  SearchCatalogReleasesResponseSchema,
  type CatalogReleaseCandidate,
  type CatalogReleaseDetail,
} from "@vinylhound/contracts";

import { Icon } from "../ui";

export default function DiscoverPage() {
  const [artist, setArtist] = useState("");
  const [title, setTitle] = useState("");
  const [results, setResults] = useState<CatalogReleaseCandidate[]>([]);
  const [searched, setSearched] = useState(false);
  const [searchPending, setSearchPending] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [detail, setDetail] = useState<CatalogReleaseDetail | null>(null);
  const [detailPending, setDetailPending] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  async function search(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!artist.trim() || !title.trim() || searchPending) return;
    setSearchPending(true);
    setSearchError(null);
    setSearched(false);
    setDetail(null);
    setDetailError(null);
    try {
      const query = new URLSearchParams({ artist, title });
      const response = await fetch(`/api/v1/catalog/releases?${query}`, {
        cache: "no-store",
      });
      const body = (await response.json()) as { error?: { message?: string } };
      if (!response.ok) {
        throw new Error(body.error?.message ?? "Catalog search failed.");
      }
      setResults(SearchCatalogReleasesResponseSchema.parse(body).results);
      setSearched(true);
    } catch (caught) {
      setResults([]);
      setSearchError(
        caught instanceof Error ? caught.message : "Catalog search failed.",
      );
    } finally {
      setSearchPending(false);
    }
  }

  async function viewDetails(candidate: CatalogReleaseCandidate) {
    if (detailPending) return;
    setDetailPending(true);
    setDetailError(null);
    setDetail(null);
    try {
      const response = await fetch(
        `/api/v1/catalog/releases/${candidate.reference.releaseId}`,
        { cache: "no-store" },
      );
      const body = (await response.json()) as { error?: { message?: string } };
      if (!response.ok) {
        throw new Error(
          body.error?.message ?? "The release details could not be loaded.",
        );
      }
      setDetail(GetCatalogReleaseResponseSchema.parse(body).release);
    } catch (caught) {
      setDetailError(
        caught instanceof Error
          ? caught.message
          : "The release details could not be loaded.",
      );
    } finally {
      setDetailPending(false);
    }
  }

  const groups = groupByReleaseGroup(results);

  return (
    <main className="content-page discover-page">
      <header className="page-heading">
        <div>
          <p className="section-kicker">Discovery</p>
          <h1>Search the catalog.</h1>
          <p>
            Look up an album directly, without scanning a cover. Results group
            pressings under the album they belong to — matching the concept
            doesn&apos;t confirm which pressing you have.
          </p>
        </div>
      </header>

      <form className="review-form discover-search-form" onSubmit={search}>
        <div className="review-fields">
          <label className="field field--wide">
            <span>Artist</span>
            <input
              onChange={(event) => setArtist(event.target.value)}
              placeholder="Miles Davis"
              required
              value={artist}
            />
          </label>
          <label className="field field--wide">
            <span>Album title</span>
            <input
              onChange={(event) => setTitle(event.target.value)}
              placeholder="Kind of Blue"
              required
              value={title}
            />
          </label>
        </div>
        <button
          className="primary-button"
          disabled={searchPending || !artist.trim() || !title.trim()}
          type="submit"
        >
          <Icon name="search" size={18} />
          {searchPending ? "Searching…" : "Search catalog"}
        </button>
        {searchError ? (
          <p className="form-error" role="alert">
            {searchError}
          </p>
        ) : null}
      </form>

      {searched && !searchError ? (
        groups.length ? (
          <div className="discover-groups" aria-label="Search results">
            {groups.map((group) => (
              <section className="discover-group" key={group.releaseGroupId}>
                <div className="review-section-heading">
                  <div>
                    <p className="section-kicker">Album</p>
                    <h2>{group.title}</h2>
                  </div>
                  <p className="field-help">
                    {group.artist} ·{" "}
                    {group.candidates.length === 1
                      ? "1 pressing found"
                      : `${group.candidates.length} pressings found`}
                  </p>
                </div>
                <div
                  className="candidate-list"
                  aria-label={`Pressings of ${group.title}`}
                >
                  {group.candidates.map((candidate) => (
                    <button
                      className={`candidate-card candidate-card--catalog${
                        detail?.reference.releaseId ===
                        candidate.reference.releaseId
                          ? " is-selected"
                          : ""
                      }`}
                      key={candidate.reference.releaseId}
                      aria-pressed={
                        detail?.reference.releaseId ===
                        candidate.reference.releaseId
                      }
                      onClick={() => viewDetails(candidate)}
                      type="button"
                    >
                      <span>
                        <strong>{candidate.title}</strong>
                        <small>
                          {[
                            candidate.releaseDate,
                            candidate.country,
                            candidate.formats.join("/"),
                          ]
                            .filter(Boolean)
                            .join(" · ") || "Details not listed"}
                        </small>
                      </span>
                      <span className="candidate-card__confidence">
                        {candidate.score}%
                      </span>
                    </button>
                  ))}
                </div>
              </section>
            ))}
          </div>
        ) : (
          <p className="empty-candidate-copy">
            No catalog releases found for that artist and title. Try a slightly
            different spelling or a shorter title.
          </p>
        )
      ) : null}

      {detailPending ? (
        <p className="field-help" role="status">
          Loading release details…
        </p>
      ) : null}
      {detailError ? (
        <p className="form-error" role="alert">
          {detailError}
        </p>
      ) : null}
      {detail ? <ReleaseDetailPanel detail={detail} /> : null}
    </main>
  );
}

function ReleaseDetailPanel({ detail }: { detail: CatalogReleaseDetail }) {
  const isConceptTitle = detail.title === detail.releaseGroupTitle;
  const sourceUrl = detail.reference.sourceUrl.startsWith("https://")
    ? detail.reference.sourceUrl
    : null;

  return (
    <section className="discover-detail" aria-live="polite">
      <div className="review-section-heading">
        <div>
          <p className="section-kicker">Pressing detail</p>
          <h2>{detail.title}</h2>
        </div>
      </div>
      <p>{detail.artist}</p>
      {!isConceptTitle ? (
        <p className="field-help">
          Part of the album <strong>{detail.releaseGroupTitle}</strong> — this
          pressing&apos;s own title differs from the album concept.
        </p>
      ) : null}

      <dl className="discover-detail__facts">
        <Fact label="Release date" value={detail.releaseDate} />
        <Fact label="Country" value={detail.country} />
        <Fact label="Format" value={detail.formats.join(", ") || null} />
        <Fact label="Packaging" value={detail.packaging} />
        <Fact label="Barcode" value={detail.barcode} />
        <Fact label="Status" value={detail.status} />
        {detail.labels.length ? (
          <Fact
            label="Label"
            value={detail.labels
              .map((label) =>
                [label.name, label.catalogNumber].filter(Boolean).join(" · "),
              )
              .join("; ")}
          />
        ) : null}
      </dl>

      {detail.tracks.length ? (
        <div className="discover-tracklist">
          <h3>Tracklist</h3>
          <ol>
            {detail.tracks.map((track, index) => (
              <li key={`${track.position}-${index}`}>
                <span className="discover-tracklist__position">
                  {track.position}
                </span>
                <span className="discover-tracklist__title">{track.title}</span>
                <span className="discover-tracklist__length">
                  {track.lengthMs ? formatDuration(track.lengthMs) : ""}
                </span>
              </li>
            ))}
          </ol>
        </div>
      ) : null}

      <p className="pressing-note">
        <Icon name="info" size={16} /> A cover match identifies the album, not a
        specific pressing. Check labels, barcode, and matrix/runout details
        against your copy before treating an edition as fact.
      </p>
      <p className="field-help">
        Source: MusicBrainz · fetched{" "}
        {new Date(detail.reference.fetchedAt).toLocaleString()}
        {sourceUrl ? (
          <>
            {" · "}
            <a href={sourceUrl} rel="noreferrer" target="_blank">
              View on MusicBrainz
            </a>
          </>
        ) : null}
      </p>
    </section>
  );
}

function Fact({ label, value }: { label: string; value: string | null }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value ?? "Unknown"}</dd>
    </div>
  );
}

function groupByReleaseGroup(candidates: CatalogReleaseCandidate[]) {
  const groups = new Map<
    string,
    {
      releaseGroupId: string;
      title: string;
      artist: string;
      candidates: CatalogReleaseCandidate[];
    }
  >();
  for (const candidate of candidates) {
    const key = candidate.reference.releaseGroupId;
    const existing = groups.get(key);
    if (existing) {
      existing.candidates.push(candidate);
    } else {
      groups.set(key, {
        releaseGroupId: key,
        title: candidate.title,
        artist: candidate.artist,
        candidates: [candidate],
      });
    }
  }
  return [...groups.values()];
}

function formatDuration(lengthMs: number) {
  const totalSeconds = Math.round(lengthMs / 1_000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}
