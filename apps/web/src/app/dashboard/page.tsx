import Link from "next/link";

import { collection, recentScans, wishlist } from "../data";
import { Art, Icon } from "../ui";
import { UserGreeting } from "../user-greeting";

export default function DashboardPage() {
  return (
    <main className="dashboard-page content-page">
      <header className="page-heading dashboard-heading">
        <div>
          <p className="section-kicker">Monday, August 24</p>
          <UserGreeting />
          <p>Your shelves are looking good. Ready to add another find?</p>
        </div>
        <Link className="primary-button desktop-action" href="/scan">
          <Icon name="camera" size={19} />
          Scan a record
        </Link>
      </header>

      <section className="hero-card">
        <div className="hero-card__art" aria-hidden="true">
          <span className="hero-record hero-record--one" />
          <span className="hero-record hero-record--two" />
          <span className="hero-sleeve">
            <BrandBadge />
          </span>
        </div>
        <div className="hero-card__copy">
          <span className="pill pill--dark">
            <Icon name="sparkle" size={14} /> Smart scanning
          </span>
          <h2>Found something worth remembering?</h2>
          <p>
            Photograph the cover and VinylHound will help you identify and file
            it in seconds.
          </p>
          <Link className="light-button" href="/scan">
            <Icon name="camera" size={18} /> Start a new scan
          </Link>
        </div>
      </section>

      <section className="dashboard-section">
        <div className="section-heading">
          <div>
            <p className="section-kicker">Your activity</p>
            <h2>Recent scans</h2>
          </div>
          <Link href="/scans">
            See all <Icon name="arrowRight" size={17} />
          </Link>
        </div>
        <div className="scan-list">
          {recentScans.map((scan) => (
            <article className="scan-row" key={scan.id}>
              <Art title={scan.title} tone={scan.tone} />
              <div className="scan-row__title">
                <h3>{scan.title}</h3>
                <p>
                  {scan.artist} · {scan.year}
                </p>
              </div>
              <span
                className={`status status--${
                  scan.status === "Matched" ? "success" : "review"
                }`}
              >
                {scan.status === "Matched" ? (
                  <Icon name="check" size={14} />
                ) : (
                  <Icon name="clock" size={14} />
                )}
                {scan.status}
              </span>
              <time>{scan.time}</time>
              <Link
                aria-label={`Open ${scan.title} scan`}
                href={`/scans#${scan.id}`}
              >
                <Icon name="chevronRight" size={18} />
              </Link>
            </article>
          ))}
        </div>
      </section>

      <div className="dashboard-columns">
        <LibraryPreview
          albums={collection.slice(0, 3)}
          count="48 records"
          href="/collection"
          title="From your collection"
        />
        <LibraryPreview
          albums={wishlist.slice(0, 3)}
          count="12 records"
          href="/wishlist"
          title="On your wishlist"
        />
      </div>
    </main>
  );
}

function BrandBadge() {
  return (
    <>
      <span>VINYL</span>
      <strong>HOUND</strong>
      <small>LISTEN DEEPER</small>
    </>
  );
}

function LibraryPreview({
  albums,
  count,
  href,
  title,
}: {
  albums: typeof collection;
  count: string;
  href: string;
  title: string;
}) {
  return (
    <section className="library-preview">
      <div className="section-heading section-heading--compact">
        <div>
          <h2>{title}</h2>
          <p>{count}</p>
        </div>
        <Link href={href}>
          View all <Icon name="arrowRight" size={17} />
        </Link>
      </div>
      <div className="album-grid album-grid--preview">
        {albums.map((album) => (
          <article className="album-card" key={album.id}>
            <Art title={album.title} tone={album.tone} />
            <h3>{album.title}</h3>
            <p>{album.artist}</p>
          </article>
        ))}
      </div>
    </section>
  );
}
