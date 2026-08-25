export type Album = {
  id: string;
  title: string;
  artist: string;
  year: string;
  genre: string;
  tone: string;
};

export const recentScans = [
  {
    ...album(
      "kind-of-blue",
      "Kind of Blue",
      "Miles Davis",
      "1959",
      "Jazz",
      "blue",
    ),
    status: "Matched",
    time: "12 min ago",
  },
  {
    ...album("rumours", "Rumours", "Fleetwood Mac", "1977", "Rock", "cream"),
    status: "Needs review",
    time: "Yesterday",
  },
  {
    ...album(
      "songs-in-key",
      "Songs in the Key of Life",
      "Stevie Wonder",
      "1976",
      "Soul",
      "sun",
    ),
    status: "Matched",
    time: "Aug 21",
  },
] as const;

export const collection: Album[] = [
  album("kind-of-blue", "Kind of Blue", "Miles Davis", "1959", "Jazz", "blue"),
  album("abbey-road", "Abbey Road", "The Beatles", "1969", "Rock", "crosswalk"),
  album(
    "miseducation",
    "The Miseducation of Lauryn Hill",
    "Lauryn Hill",
    "1998",
    "Hip-hop",
    "classroom",
  ),
  album("discovery", "Discovery", "Daft Punk", "2001", "Electronic", "chrome"),
  album("blue", "Blue", "Joni Mitchell", "1971", "Folk", "ocean"),
  album(
    "whats-going-on",
    "What’s Going On",
    "Marvin Gaye",
    "1971",
    "Soul",
    "green",
  ),
];

export const wishlist: Album[] = [
  album("vespertine", "Vespertine", "Björk", "2001", "Electronic", "snow"),
  album("mama-gun", "Mama’s Gun", "Erykah Badu", "2000", "Neo soul", "red"),
  album(
    "in-rainbows",
    "In Rainbows",
    "Radiohead",
    "2007",
    "Alternative",
    "rainbow",
  ),
  album(
    "titanic-rising",
    "Titanic Rising",
    "Weyes Blood",
    "2019",
    "Indie",
    "water",
  ),
];

function album(
  id: string,
  title: string,
  artist: string,
  year: string,
  genre: string,
  tone: string,
): Album {
  return { id, title, artist, year, genre, tone };
}
