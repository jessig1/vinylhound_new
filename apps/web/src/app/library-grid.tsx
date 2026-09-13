"use client";

import { useState } from "react";

import {
  GetFavoritesResponseSchema,
  GetLibraryResponseSchema,
  parseResponse,
  type LibraryItemResult,
  type LibraryList,
  type LibrarySort,
} from "@vinylhound/contracts";

import { LibraryAlbumCard } from "./library-album-card";

/**
 * The grid of saved records on the collection, wishlist and favorites
 * pages. The server renders the first page; "Show more" appends the next
 * page through the same paged read the page used (ADR-0023), continuing
 * from the cursor the previous page returned, so a record added or edited
 * meanwhile is never shown twice or dropped from the sequence. The parent
 * keys this component on the list, search and sort, so a new query starts
 * over from its own first page.
 */
export function LibraryGrid({
  initialItems,
  initialCursor,
  label,
  list,
  query,
  sort,
}: {
  initialItems: LibraryItemResult[];
  initialCursor: string | null;
  label: string;
  /** Omitted on the favorites view, which reads across both lists. */
  list?: LibraryList;
  query: string;
  sort: LibrarySort;
}) {
  const [items, setItems] = useState(initialItems);
  const [cursor, setCursor] = useState(initialCursor);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [announcement, setAnnouncement] = useState("");

  async function showMore() {
    if (!cursor || loading) return;
    setLoading(true);
    setFailed(false);
    try {
      const params = new URLSearchParams({ cursor });
      if (list) params.set("list", list);
      if (query) params.set("q", query);
      if (sort !== "recent") params.set("sort", sort);
      const endpoint = list ? "/api/v1/library" : "/api/v1/library/favorites";
      const response = await fetch(`${endpoint}?${params.toString()}`, {
        cache: "no-store",
      });
      if (!response.ok)
        throw new Error(`Page request failed (${response.status})`);
      const json: unknown = await response.json();
      const page = list
        ? parseResponse(GetLibraryResponseSchema, json)
        : parseResponse(GetFavoritesResponseSchema, json);
      setItems((current) => [...current, ...page.items]);
      setCursor(page.nextCursor);
      setAnnouncement(
        `${page.items.length} more ${page.items.length === 1 ? "record" : "records"} shown.`,
      );
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <section className="album-grid album-grid--library" aria-label={label}>
        {items.map((item) => (
          <LibraryAlbumCard item={item} key={item.id} />
        ))}
      </section>
      <p aria-live="polite" className="visually-hidden">
        {announcement}
      </p>
      {cursor ? (
        <div className="library-pager">
          <button
            className="secondary-button"
            disabled={loading}
            onClick={() => void showMore()}
            type="button"
          >
            {loading ? "Loading…" : "Show more"}
          </button>
          {failed ? (
            <p className="form-error" role="alert">
              Couldn’t load more records. Check your connection and try again.
            </p>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
