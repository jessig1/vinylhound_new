import Link from "next/link";

import { Icon, type IconName } from "./ui";

export type SavedMusicView =
  "collection" | "wishlist" | "favorites" | "playlists";

const views: {
  view: SavedMusicView;
  href: string;
  label: string;
  icon: IconName;
}[] = [
  {
    view: "collection",
    href: "/collection",
    label: "Collection",
    icon: "collection",
  },
  { view: "wishlist", href: "/wishlist", label: "Wishlist", icon: "heart" },
  { view: "favorites", href: "/favorites", label: "Favorites", icon: "star" },
  {
    view: "playlists",
    href: "/playlists",
    label: "Playlists",
    icon: "playlist",
  },
];

/**
 * The four views of saved music, as a strip on each of their pages. The
 * phone bottom bar is already at six columns, so favorites and playlists are
 * reached from here (and the desktop sidebar) rather than crowding it.
 */
export function SavedMusicNav({ current }: { current: SavedMusicView }) {
  return (
    <nav aria-label="Saved music" className="saved-music-nav">
      {views.map((entry) => (
        <Link
          aria-current={entry.view === current ? "page" : undefined}
          className={entry.view === current ? "is-active" : ""}
          href={entry.href}
          key={entry.view}
        >
          <Icon name={entry.icon} size={15} />
          {entry.label}
        </Link>
      ))}
    </nav>
  );
}
