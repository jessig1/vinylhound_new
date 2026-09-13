import Link from "next/link";

import {
  countLibraryItemsForUser,
  listLibraryItemsForUser,
  listScansForUser,
} from "@vinylhound/database";

import { requireUserId } from "@/server/auth";
import { getServerContext } from "@/server/context";

import { CoverArt } from "../cover-art";
import { Icon } from "../ui";
import { UserGreeting } from "../user-greeting";
import { ScanActivityRow } from "./scan-activity-row";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const context = getServerContext();
  const userId = await requireUserId(context);
  const [scans, collection, wishlist, collectionCount, wishlistCount] =
    await Promise.all([
      listScansForUser(context.database.db, { userId, limit: 3 }),
      // The previews show three records each; the counts come separately.
      listLibraryItemsForUser(context.database.db, {
        userId,
        list: "collection",
        limit: 3,
      }),
      listLibraryItemsForUser(context.database.db, {
        userId,
        list: "wishlist",
        limit: 3,
      }),
      countLibraryItemsForUser(context.database.db, {
        userId,
        list: "collection",
      }),
      countLibraryItemsForUser(context.database.db, {
        userId,
        list: "wishlist",
      }),
    ]);

  return (
    <main className="dashboard-page content-page">
      <header className="page-heading dashboard-heading">
        <div>
          <p className="section-kicker">
            {new Intl.DateTimeFormat("en-US", {
              weekday: "long",
              month: "long",
              day: "numeric",
            }).format(new Date())}
          </p>
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
            <h2>Latest scans</h2>
          </div>
          <Link href="/scans">
            See all <Icon name="arrowRight" size={17} />
          </Link>
        </div>
        {scans.summaries.length ? (
          <div className="scan-list scan-list--activity">
            {scans.summaries.map((scan) => (
              <ScanActivityRow key={scan.scanId} scan={scan} />
            ))}
          </div>
        ) : (
          <DashboardEmpty message="Your latest scans will appear here." />
        )}
      </section>

      <div className="dashboard-columns">
        <LibraryPreview
          albums={collection.items}
          count={collectionCount}
          emptyMessage="Records you add to your shelf will appear here."
          href="/collection"
          title="Collection"
        />
        <LibraryPreview
          albums={wishlist.items}
          count={wishlistCount}
          emptyMessage="Records you save for later will appear here."
          href="/wishlist"
          title="Wishlist"
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
  emptyMessage,
  href,
  title,
}: {
  albums: Awaited<ReturnType<typeof listLibraryItemsForUser>>["items"];
  count: number;
  emptyMessage: string;
  href: string;
  title: string;
}) {
  return (
    <section className="library-preview">
      <div className="section-heading section-heading--compact">
        <div>
          <h2>{title}</h2>
          <p>
            {count} {count === 1 ? "record" : "records"}
          </p>
        </div>
        <Link href={href}>
          View all <Icon name="arrowRight" size={17} />
        </Link>
      </div>
      {albums.length ? (
        <div className="album-grid album-grid--preview">
          {albums.map((item) => (
            <Link
              className="album-card"
              href={`/library/${item.id}`}
              key={item.id}
            >
              <CoverArt
                image={item.coverImage}
                title={item.release.title}
                tone={toneFor(item.id)}
              />
              <h3>{item.release.title}</h3>
              <p>{item.release.artist}</p>
            </Link>
          ))}
        </div>
      ) : (
        <DashboardEmpty message={emptyMessage} />
      )}
    </section>
  );
}

function DashboardEmpty({ message }: { message: string }) {
  return <p className="dashboard-empty">{message}</p>;
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
