import Link from "next/link";

import type { LibraryList, LibrarySort } from "@vinylhound/contracts";
import { LibrarySortSchema } from "@vinylhound/contracts";
import { listLibraryItemsForUser } from "@vinylhound/database";

import { requireUserId } from "@/server/auth";
import { getServerContext } from "@/server/context";

import { LibraryAlbumCard } from "./library-album-card";
import { LibraryToolbar } from "./library-toolbar";
import { SavedMusicNav } from "./saved-music-nav";
import { Icon } from "./ui";

export async function LibraryPage({
  description,
  list,
  title,
  searchParams,
}: {
  description: string;
  list: LibraryList;
  title: string;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const query = firstValue(params.q);
  const parsedSort = LibrarySortSchema.safeParse(firstValue(params.sort));
  const sort: LibrarySort = parsedSort.success ? parsedSort.data : "recent";

  const context = getServerContext();
  const userId = await requireUserId(context);
  const library = await listLibraryItemsForUser(context.database.db, {
    userId,
    list,
    query,
    sort,
  });
  const wishlist = list === "wishlist";

  return (
    <main className="content-page library-page">
      <header className="page-heading">
        <div>
          <p className="section-kicker">
            {wishlist ? "Want list" : "Record shelf"}
          </p>
          <h1>{title}</h1>
          <p>{description}</p>
        </div>
      </header>

      <SavedMusicNav current={list} />

      <LibraryToolbar
        list={list}
        query={query ?? ""}
        sort={sort}
        title={title}
      />

      {library.items.length ? (
        <section className="album-grid album-grid--library" aria-label={title}>
          {library.items.map((item) => (
            <LibraryAlbumCard item={item} key={item.id} />
          ))}
        </section>
      ) : (
        <section className="library-empty">
          <span className="upload-card__icon">
            <Icon name={wishlist ? "heart" : "collection"} size={27} />
          </span>
          <h2>
            {query
              ? "No matching records."
              : wishlist
                ? "Nothing on your wishlist yet."
                : "Your shelf is empty."}
          </h2>
          <p>
            {query
              ? "Try a different search, or clear it to see everything."
              : "Scan a cover, review the match, and save the record here."}
          </p>
          {query ? (
            <Link
              className="secondary-button"
              href={`/${list}${sort === "recent" ? "" : `?sort=${sort}`}`}
            >
              Clear search
            </Link>
          ) : (
            <Link className="primary-button" href="/scan">
              <Icon name="camera" size={18} /> Scan a record
            </Link>
          )}
        </section>
      )}
    </main>
  );
}

export function firstValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}
