import Link from "next/link";

import type { LibrarySort } from "@vinylhound/contracts";
import { LibrarySortSchema } from "@vinylhound/contracts";
import { listFavoriteLibraryItemsForUser } from "@vinylhound/database";

import { requireUserId } from "@/server/auth";
import { getServerContext } from "@/server/context";

import { LibraryAlbumCard } from "../library-album-card";
import { firstValue } from "../library-page";
import { LibraryToolbar } from "../library-toolbar";
import { SavedMusicNav } from "../saved-music-nav";
import { Icon } from "../ui";

export const dynamic = "force-dynamic";

/**
 * Favorites across both lists. A favorite is an attribute of a saved record
 * rather than a third list (ADR-0021), so this page reads the same records
 * `/collection` and `/wishlist` show, filtered to the ones marked.
 */
export default async function FavoritesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const query = firstValue(params.q);
  const parsedSort = LibrarySortSchema.safeParse(firstValue(params.sort));
  const sort: LibrarySort = parsedSort.success ? parsedSort.data : "recent";

  const context = getServerContext();
  const userId = await requireUserId(context);
  const favorites = await listFavoriteLibraryItemsForUser(
    context.database.db,
    { userId, query, sort },
  );

  return (
    <main className="content-page library-page">
      <header className="page-heading">
        <div>
          <p className="section-kicker">Saved music</p>
          <h1>Your favorites</h1>
          <p>
            Records you starred, from your collection and your wishlist alike.
          </p>
        </div>
      </header>

      <SavedMusicNav current="favorites" />

      <LibraryToolbar query={query ?? ""} sort={sort} title="Your favorites" />

      {favorites.items.length ? (
        <section
          className="album-grid album-grid--library"
          aria-label="Your favorites"
        >
          {favorites.items.map((item) => (
            <LibraryAlbumCard item={item} key={item.id} />
          ))}
        </section>
      ) : (
        <section className="library-empty">
          <span className="upload-card__icon">
            <Icon name="star" size={27} />
          </span>
          <h2>{query ? "No matching favorites." : "No favorites yet."}</h2>
          <p>
            {query
              ? "Try a different search, or clear it to see every favorite."
              : "Open any saved record and tap “Add to favorites” to keep it here."}
          </p>
          {query ? (
            <Link
              className="secondary-button"
              href={`/favorites${sort === "recent" ? "" : `?sort=${sort}`}`}
            >
              Clear search
            </Link>
          ) : (
            <Link className="secondary-button" href="/collection">
              <Icon name="collection" size={18} /> Browse your collection
            </Link>
          )}
        </section>
      )}
    </main>
  );
}
