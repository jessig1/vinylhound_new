import Link from "next/link";

import type { LibraryList } from "@vinylhound/contracts";
import { listLibraryItemsForUser } from "@vinylhound/database";

import { getServerContext } from "@/server/context";

import { Art, Icon } from "./ui";

export async function LibraryPage({
  description,
  list,
  title,
}: {
  description: string;
  list: LibraryList;
  title: string;
}) {
  const context = getServerContext();
  const library = await listLibraryItemsForUser(context.database.db, {
    userId: context.config.DEVELOPMENT_USER_ID,
    list,
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

      <div className="library-toolbar">
        <label className="search-box">
          <Icon name="search" size={18} />
          <input
            aria-label={`Search ${title.toLowerCase()}`}
            placeholder="Search by artist or album"
          />
        </label>
        <button className="filter-button" type="button">
          Recently added <span>⌄</span>
        </button>
      </div>

      {library.items.length ? (
        <section className="album-grid album-grid--library" aria-label={title}>
          {library.items.map((item) => {
            const release = item.release;
            const facts = [
              release.releaseYear?.toString(),
              release.label,
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
            {wishlist
              ? "Nothing on your wishlist yet."
              : "Your shelf is empty."}
          </h2>
          <p>Scan a cover, review the match, and save the record here.</p>
          <Link className="primary-button" href="/scan">
            <Icon name="camera" size={18} /> Scan a record
          </Link>
        </section>
      )}
    </main>
  );
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
