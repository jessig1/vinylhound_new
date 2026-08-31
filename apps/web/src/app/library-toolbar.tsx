"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";

import type { LibraryList, LibrarySort } from "@vinylhound/contracts";

import { Icon } from "./ui";

const SORT_LABELS: Record<LibrarySort, string> = {
  recent: "Recently added",
  artist: "Artist",
  title: "Title",
};

export function LibraryToolbar({
  list,
  query,
  sort,
  title,
}: {
  list: LibraryList;
  query: string;
  sort: LibrarySort;
  title: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [draftQuery, setDraftQuery] = useState(query);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setDraftQuery(query);
  }, [query]);

  function navigate(nextQuery: string, nextSort: LibrarySort) {
    const params = new URLSearchParams();
    if (nextQuery) params.set("q", nextQuery);
    if (nextSort !== "recent") params.set("sort", nextSort);
    const queryString = params.toString();
    router.replace(queryString ? `${pathname}?${queryString}` : pathname);
  }

  function onQueryChange(value: string) {
    setDraftQuery(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => navigate(value, sort), 300);
  }

  function onSortChange(value: LibrarySort) {
    navigate(draftQuery, value);
  }

  const exportParams = new URLSearchParams({ list });
  if (query) exportParams.set("q", query);
  if (sort !== "recent") exportParams.set("sort", sort);

  return (
    <div className="library-toolbar">
      <label className="search-box">
        <Icon name="search" size={18} />
        <input
          aria-label={`Search ${title.toLowerCase()}`}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder="Search by artist or album"
          value={draftQuery}
        />
      </label>
      <div className="library-toolbar__controls">
        <select
          aria-label="Sort"
          className="filter-button"
          onChange={(event) => onSortChange(event.target.value as LibrarySort)}
          value={sort}
        >
          {Object.entries(SORT_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
        <a
          className="filter-button library-toolbar__export"
          href={`/api/v1/library/export?${exportParams.toString()}`}
        >
          Export
        </a>
      </div>
    </div>
  );
}
