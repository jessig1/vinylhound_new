import Link from "next/link";
import { notFound } from "next/navigation";

import type { LibraryItemResult } from "@vinylhound/contracts";
import {
  DatabaseCommandError,
  getLibraryItemForUser,
} from "@vinylhound/database";

import { requireUserId } from "@/server/auth";
import { getServerContext } from "@/server/context";

import { CoverArt } from "../../cover-art";
import { LibraryCopyEditor } from "../../library-copy-editor";
import { LibraryItemActions } from "../../library-item-actions";
import { LibraryNotesEditor } from "../../library-notes-editor";
import { Icon } from "../../ui";

export const dynamic = "force-dynamic";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function LibraryItemPage({
  params,
}: {
  params: Promise<{ itemId: string }>;
}) {
  const { itemId } = await params;
  if (!UUID_PATTERN.test(itemId)) notFound();

  const context = getServerContext();
  const userId = await requireUserId(context);
  const item = await getLibraryItemForUser(context.database.db, {
    userId,
    itemId,
  }).catch((error: unknown) => {
    if (error instanceof DatabaseCommandError && error.code === "not_found") {
      notFound();
    }
    throw error;
  });

  const { release } = item;
  const wishlist = item.list === "wishlist";
  const facts = releaseFacts(item);

  return (
    <main className="content-page library-item-page">
      <Link className="back-link" href={`/${item.list}`}>
        <Icon name="arrowLeft" size={17} />
        Back to {wishlist ? "wishlist" : "collection"}
      </Link>

      <div className="library-item-layout">
        <header className="page-heading library-item-heading">
          <p className="section-kicker">
            {wishlist ? "Want list" : "Record shelf"}
          </p>
          <h1>{release.title}</h1>
          <p className="result-artist">{release.artist}</p>
        </header>

        <div className="library-item-cover">
          <CoverArt
            image={item.coverImage}
            title={release.title}
            tone={toneFor(item.id)}
          />
          <span
            className={`status ${wishlist ? "status--review" : "status--success"}`}
          >
            <Icon name={wishlist ? "heart" : "collection"} size={14} />
            {wishlist ? "On your wishlist" : "In your collection"}
          </span>
          {item.confirmedFromScanId ? (
            <Link
              className="text-button"
              href={`/scans/${item.confirmedFromScanId}`}
            >
              View the original scan
            </Link>
          ) : null}
        </div>

        <div className="library-item-main">
          <section className="settings-card">
            <h2>Release details</h2>
            {facts.length ? (
              <dl className="detail-list">
                {facts.map((fact) => (
                  <div key={fact.label}>
                    <dt>{fact.label}</dt>
                    <dd>{fact.value}</dd>
                  </div>
                ))}
              </dl>
            ) : (
              <p className="field-help">
                No edition details were recorded for this release. Open the
                original scan to add them.
              </p>
            )}
            <CatalogLink item={item} />
            <p className="pressing-note">
              <Icon name="info" size={16} /> A cover identifies a release
              concept. Only edition details you verified from the record itself
              prove a specific pressing.
            </p>
          </section>

          <section className="settings-card">
            <h2>Your notes</h2>
            <LibraryNotesEditor itemId={item.id} notes={item.notes} />
          </section>

          {wishlist ? null : (
            <section className="settings-card">
              <h2>
                {item.copyCount} physical{" "}
                {item.copyCount === 1 ? "copy" : "copies"}
              </h2>
              {item.copies.length ? (
                <div className="copy-list">
                  {item.copies.map((copy, index) => (
                    <LibraryCopyEditor
                      copy={copy}
                      index={index + 1}
                      itemId={item.id}
                      key={copy.id}
                    />
                  ))}
                </div>
              ) : (
                <p className="field-help">
                  No copies are recorded yet. Moving this record here from your
                  wishlist adds one automatically.
                </p>
              )}
            </section>
          )}

          <section className="settings-card">
            <h2>Manage this record</h2>
            <LibraryItemActions
              copyCount={item.copyCount}
              itemId={item.id}
              list={item.list}
              title={release.title}
            />
          </section>
        </div>
      </div>
    </main>
  );
}

function CatalogLink({ item }: { item: LibraryItemResult }) {
  const reference = item.release.catalogReference;
  // Only https links are rendered: the reference travels through a client-sent
  // confirmation body, so its URL is not trusted as an href by default.
  if (!reference || !reference.sourceUrl.startsWith("https://")) {
    return (
      <p className="field-help">
        No catalog release is linked to this record yet.
      </p>
    );
  }
  return (
    <p className="catalog-link">
      <a href={reference.sourceUrl} rel="noreferrer noopener" target="_blank">
        View this edition on MusicBrainz
      </a>{" "}
      <small>
        Matched {new Date(reference.fetchedAt).toLocaleDateString()}
      </small>
    </p>
  );
}

function releaseFacts(item: LibraryItemResult) {
  const { release } = item;
  const entries: Array<{ label: string; value: string }> = [];
  const add = (label: string, value: string | number | null) => {
    if (value !== null && value !== "")
      entries.push({ label, value: String(value) });
  };

  add("Released", release.releaseDate ?? release.releaseYear);
  add("Label", release.label);
  add("Catalog number", release.catalogNumber);
  add("Format", release.format);
  add("Country", release.country);
  add("Packaging", release.packaging);
  add("Status", release.releaseStatus);
  add("Barcode", release.barcode);
  add("Saved", new Date(item.createdAt).toLocaleDateString());
  return entries;
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
