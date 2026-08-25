import type { Album } from "./data";
import { Art, Icon } from "./ui";

export function LibraryPage({
  albums,
  description,
  title,
  wishlist = false,
}: {
  albums: Album[];
  description: string;
  title: string;
  wishlist?: boolean;
}) {
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

      <section className="album-grid album-grid--library" aria-label={title}>
        {albums.map((album) => (
          <article className="album-card album-card--large" key={album.id}>
            <div className="album-card__art-wrap">
              <Art title={album.title} tone={album.tone} />
              {wishlist ? (
                <span className="heart-badge">
                  <Icon name="heart" size={17} />
                </span>
              ) : null}
            </div>
            <h2>{album.title}</h2>
            <p>{album.artist}</p>
            <small>
              {album.year} · {album.genre}
            </small>
          </article>
        ))}
      </section>
    </main>
  );
}
