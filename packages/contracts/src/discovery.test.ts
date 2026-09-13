import { describe, expect, it } from "vitest";

import {
  DiscoveryAlbumDetailSchema,
  DiscoveryAlbumSchema,
  DiscoveryIdSchema,
  DiscoverySearchQuerySchema,
  DiscoverySearchResponseSchema,
  DiscoveryTrackSchema,
} from "./discovery.ts";

const albumId = "4sb0eMpDn3upAFfyi4q2rw";
const artistId = "0kbYTNQb4Pb1rPbbaF0pT4";
const trackId = "1Nqv0wVvgtxqVOQpkr3cPB";

const album = {
  id: albumId,
  title: "Kind of Blue",
  artist: "Miles Davis",
  artistIds: [artistId],
  albumType: "album",
  releaseDate: "1959-08-17",
  releaseYear: 1959,
  totalTracks: 5,
  coverUrl: "https://i.scdn.co/image/ab67616d0000b2730000000000000000deadbeef",
  externalUrl: `https://open.spotify.com/album/${albumId}`,
};

const track = {
  id: trackId,
  title: "So What",
  artist: "Miles Davis",
  albumId,
  albumTitle: "Kind of Blue",
  coverUrl: album.coverUrl,
  durationMs: 562_000,
  trackNumber: 1,
  discNumber: 1,
  externalUrl: `https://open.spotify.com/track/${trackId}`,
};

describe("DiscoveryIdSchema", () => {
  it("accepts a 22-character base-62 Spotify ID and nothing else", () => {
    expect(DiscoveryIdSchema.parse(albumId)).toBe(albumId);
    expect(() => DiscoveryIdSchema.parse(albumId.slice(1))).toThrow();
    expect(() =>
      DiscoveryIdSchema.parse("8b9c0d1e-2f3a-4b4c-9d6e-7f8a9b0c1d15"),
    ).toThrow();
  });
});

describe("DiscoveryAlbumSchema", () => {
  it("accepts a streaming album with its artwork and release precision", () => {
    expect(DiscoveryAlbumSchema.parse(album)).toEqual(album);
    expect(
      DiscoveryAlbumSchema.parse({ ...album, releaseDate: "1959" }).releaseDate,
    ).toBe("1959");
  });

  it("carries no pressing fields — those are not Spotify's to answer", () => {
    for (const field of ["catalogNumber", "country", "format", "packaging"]) {
      expect(() =>
        DiscoveryAlbumSchema.parse({ ...album, [field]: "x" }),
      ).toThrow();
    }
  });

  it("allows unknown artwork, track count and date rather than inventing them", () => {
    const sparse = {
      ...album,
      releaseDate: null,
      releaseYear: null,
      totalTracks: null,
      coverUrl: null,
    };
    expect(DiscoveryAlbumSchema.parse(sparse)).toEqual(sparse);
  });
});

describe("DiscoveryTrackSchema", () => {
  it("accepts a track that may be missing its album context", () => {
    const orphan = {
      ...track,
      albumId: null,
      albumTitle: null,
      coverUrl: null,
      durationMs: null,
      trackNumber: null,
      discNumber: null,
    };
    expect(DiscoveryTrackSchema.parse(orphan)).toEqual(orphan);
  });

  it("rejects a non-positive duration or position", () => {
    expect(() =>
      DiscoveryTrackSchema.parse({ ...track, durationMs: 0 }),
    ).toThrow();
    expect(() =>
      DiscoveryTrackSchema.parse({ ...track, trackNumber: 0 }),
    ).toThrow();
  });
});

describe("DiscoveryAlbumDetailSchema", () => {
  it("adds only label, barcode, genres and tracks to the album summary", () => {
    const detail = {
      ...album,
      label: "Columbia/Legacy",
      barcode: "074646493526",
      genres: ["jazz"],
      tracks: [track],
    };
    expect(DiscoveryAlbumDetailSchema.parse(detail)).toEqual(detail);
    expect(() =>
      DiscoveryAlbumDetailSchema.parse({ ...detail, catalogNumber: "CS 8163" }),
    ).toThrow();
  });
});

describe("DiscoverySearchResponseSchema", () => {
  it("returns three sections and echoes the query it answered", () => {
    const response = {
      query: "kind of blue",
      type: "all",
      artists: [],
      albums: [album],
      tracks: [track],
    };
    expect(DiscoverySearchResponseSchema.parse(response)).toEqual(response);
  });

  it("caps each section at 50 results", () => {
    expect(() =>
      DiscoverySearchResponseSchema.parse({
        query: "x",
        type: "album",
        artists: [],
        albums: Array.from({ length: 51 }, () => album),
        tracks: [],
      }),
    ).toThrow();
  });
});

describe("DiscoverySearchQuerySchema", () => {
  it("defaults to a unified search of ten results", () => {
    expect(DiscoverySearchQuerySchema.parse({ q: " miles " })).toEqual({
      q: "miles",
      type: "all",
      limit: 10,
    });
  });

  it("coerces the limit from the query string and bounds it", () => {
    expect(
      DiscoverySearchQuerySchema.parse({ q: "a", limit: "25" }).limit,
    ).toBe(25);
    expect(() =>
      DiscoverySearchQuerySchema.parse({ q: "a", limit: "51" }),
    ).toThrow();
    expect(() => DiscoverySearchQuerySchema.parse({ q: "" })).toThrow();
  });
});
