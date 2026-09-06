import Link from "next/link";

import type { LibraryList, LibrarySort } from "@vinylhound/contracts";
import { LibrarySortSchema } from "@vinylhound/contracts";
import { listLibraryItemsForUser } from "@vinylhound/database";

import { requireUserId } from "@/server/auth";
import { getServerContext } from "@/server/context";

import { LibraryItemActions } from "./library-item-actions";
import { LibraryCopyEditor } from "./library-copy-editor";
import { LibraryToolbar } from "./library-toolbar";
import { Art, Icon } from "./ui";

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

      <LibraryToolbar
        list={list}
        query={query ?? ""}
        sort={sort}
        title={title}
      />

      {library.items.length ? (
        <section className="album-grid album-grid--library" aria-label={title}>
          {library.items.map((item) => {
            const release = item.release;
            const facts = [
              release.releaseYear?.toString(),
              release.label,
              release.format,
              release.country,
            ].filter(Boolean);
            return (
              <article className="album-card album-card--large" key={item.id}>
                <div className="album-card__art-wrap">
                  <Art title={release.title} tone={toneFor(item.id)} />
                  {wishlist ? (
                    <span className="heart-badge">
                      <Icon name="heart" size={17} />
                    </span>
                  ) : null}
                </div>
                <h2>{release.title}</h2>
                <p>{release.artist}</p>
                <small>{facts.join(" · ") || "Release details not set"}</small>
                {!wishlist ? (
                  <>
                    <small>
                      {item.copyCount}{" "}
                      {item.copyCount === 1 ? "copy" : "copies"}
                    </small>
                    {item.copies.map((copy) => (
                      <LibraryCopyEditor
                        copy={copy}
                        itemId={item.id}
                        key={copy.id}
                      />
                    ))}
                  </>
                ) : null}
                <LibraryItemActions
                  copyCount={item.copyCount}
                  hasConfirmationHistory={item.confirmedFromScanId !== null}
                  itemId={item.id}
                  list={item.list}
                />
              </article>
            );
          })}
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

function firstValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

const tones = [
  "blue",
  "cream",
  "sun",
  "crosswalk",
  "classroom",
  "chrome",
  "ocean",
  "green",
  "snow",
  "red",
  "rainbow",
  "water",
] as const;

function toneFor(id: string) {
  let value = 0;
  for (const character of id) value = (value + character.charCodeAt(0)) % 997;
  return tones[value % tones.length]!;
}
