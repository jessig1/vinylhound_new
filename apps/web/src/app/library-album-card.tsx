import Link from "next/link";

import type { LibraryItemResult } from "@vinylhound/contracts";

import { CoverArt } from "./cover-art";
import { Icon } from "./ui";

/**
 * One saved record in a grid, linking to its detail page. Shared by the
 * collection, wishlist and favorites pages so a record looks the same
 * whichever view it is reached from.
 */
export function LibraryAlbumCard({ item }: { item: LibraryItemResult }) {
  const release = item.release;
  const wishlist = item.list === "wishlist";
  const facts = [
    release.releaseYear?.toString(),
    release.label,
    release.format,
    release.country,
  ].filter(Boolean);
  return (
    <Link className="album-card album-card--large" href={`/library/${item.id}`}>
      <div className="album-card__art-wrap">
        <CoverArt
          image={item.coverImage}
          title={release.title}
          tone={toneForId(item.id)}
        />
        {wishlist ? (
          <span className="heart-badge">
            <Icon name="heart" size={17} />
          </span>
        ) : null}
        {item.favoritedAt ? (
          <span className="star-badge" title="Favorite">
            <Icon name="star" size={15} />
            <span className="visually-hidden">Favorite</span>
          </span>
        ) : null}
        {!wishlist && item.copyCount > 1 ? (
          <span className="copy-badge">{item.copyCount} copies</span>
        ) : null}
      </div>
      <h2>{release.title}</h2>
      <p>{release.artist}</p>
      <small>{facts.join(" · ") || "Release details not set"}</small>
      {item.notes ? (
        <small className="album-card__note">
          <Icon name="info" size={13} /> {item.notes}
        </small>
      ) : null}
    </Link>
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

export function toneForId(id: string) {
  let value = 0;
  for (const character of id) value = (value + character.charCodeAt(0)) % 997;
  return tones[value % tones.length]!;
}
