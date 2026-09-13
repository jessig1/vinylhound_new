import { describe, expect, it } from "vitest";

import {
  CatalogLabelSchema,
  CatalogReferenceSchema,
  CatalogReleaseCandidateSchema,
  CatalogReleaseDetailSchema,
  CatalogTrackSchema,
  GetCatalogReleaseResponseSchema,
  SearchCatalogReleasesResponseSchema,
} from "./catalog.ts";

const reference = {
  provider: "musicbrainz",
  releaseGroupId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  releaseId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  sourceUrl:
    "https://musicbrainz.org/release/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  fetchedAt: "2026-08-31T12:00:00.000Z",
};

const detail = {
  reference,
  artist: "Miles Davis",
  title: "Kind of Blue",
  releaseDate: "1959-08-17",
  country: "US",
  labels: [{ name: "Columbia", catalogNumber: "CS 8163" }],
  barcode: null,
  formats: ['12" Vinyl'],
  packaging: "Cardboard/Paper Sleeve",
  status: "Official",
  score: 98,
  releaseGroupTitle: "Kind of Blue",
  tracks: [
    { position: "A1", title: "So What", lengthMs: 562_000 },
    { position: "A2", title: "Freddie Freeloader", lengthMs: 590_000 },
  ],
};

describe("CatalogReleaseDetailSchema", () => {
  it("accepts a full pressing detail with provenance and a track listing", () => {
    expect(CatalogReleaseDetailSchema.parse(detail)).toEqual(detail);
  });

  it("distinguishes the release group (album concept) from the release (pressing)", () => {
    const reissue = {
      ...detail,
      title: "Kind of Blue (2015 Reissue)",
      releaseGroupTitle: "Kind of Blue",
    };
    const parsed = CatalogReleaseDetailSchema.parse(reissue);
    expect(parsed.reference.releaseGroupId).toBe(reference.releaseGroupId);
    expect(parsed.reference.releaseId).toBe(reference.releaseId);
    expect(parsed.releaseGroupTitle).not.toBe(parsed.title);
  });

  it("rejects an unexpected extra field", () => {
    expect(() =>
      CatalogReleaseDetailSchema.parse({ ...detail, extra: true }),
    ).toThrow();
  });

  it("caps the track listing at 200 entries", () => {
    const tooManyTracks = {
      ...detail,
      tracks: Array.from({ length: 201 }, (_, index) => ({
        position: String(index + 1),
        title: `Track ${index + 1}`,
        lengthMs: null,
      })),
    };
    expect(() => CatalogReleaseDetailSchema.parse(tooManyTracks)).toThrow();
  });
});

describe("GetCatalogReleaseResponseSchema", () => {
  it("wraps a single release detail", () => {
    expect(GetCatalogReleaseResponseSchema.parse({ release: detail })).toEqual({
      release: detail,
    });
  });
});

describe("CatalogReferenceSchema across providers", () => {
  const spotifyReference = {
    provider: "spotify" as const,
    releaseGroupId: "1weenld61qoidwYuZ1GESA",
    releaseId: null,
    sourceUrl: "https://open.spotify.com/album/1weenld61qoidwYuZ1GESA",
    fetchedAt: "2026-09-11T12:00:00.000Z",
  };

  it("accepts a MusicBrainz reference naming both a release group and a pressing", () => {
    expect(CatalogReferenceSchema.parse(reference)).toMatchObject({
      provider: "musicbrainz",
      releaseId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    });
  });

  it("requires a MusicBrainz reference to carry the pressing it models", () => {
    expect(
      CatalogReferenceSchema.safeParse({ ...reference, releaseId: null })
        .success,
    ).toBe(false);
  });

  it("rejects a MusicBrainz reference whose identifiers are not MBIDs", () => {
    expect(
      CatalogReferenceSchema.safeParse({
        ...reference,
        releaseGroupId: "1weenld61qoidwYuZ1GESA",
      }).success,
    ).toBe(false);
  });

  it("accepts a Spotify reference that identifies an album concept only", () => {
    expect(CatalogReferenceSchema.parse(spotifyReference)).toMatchObject({
      provider: "spotify",
      releaseId: null,
    });
  });

  it("refuses to let a Spotify reference claim a pressing", () => {
    expect(
      CatalogReferenceSchema.safeParse({
        ...spotifyReference,
        releaseId: "1weenld61qoidwYuZ1GESA",
      }).success,
    ).toBe(false);
  });

  it("rejects a Spotify reference whose album ID is not a Spotify ID", () => {
    expect(
      CatalogReferenceSchema.safeParse({
        ...spotifyReference,
        releaseGroupId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      }).success,
    ).toBe(false);
  });

  it("still accepts references persisted before Spotify existed", () => {
    // Rows written by earlier deployments carry exactly this shape; widening
    // the provider must not invalidate them.
    expect(
      CatalogReferenceSchema.safeParse({
        provider: "musicbrainz",
        releaseGroupId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        releaseId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        sourceUrl:
          "https://musicbrainz.org/release/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        fetchedAt: "2026-08-31T12:00:00.000Z",
      }).success,
    ).toBe(true);
  });
});

/** The search-hit shape: a detail without the group title and track listing. */
const candidate = Object.fromEntries(
  Object.entries(detail).filter(
    ([key]) => key !== "releaseGroupTitle" && key !== "tracks",
  ),
);

describe("CatalogReleaseCandidateSchema", () => {
  it("accepts a search hit with a provider score and no track listing", () => {
    expect(CatalogReleaseCandidateSchema.parse(candidate)).toEqual(candidate);
  });

  it("bounds the score to a percentage and the date to year precision or finer", () => {
    expect(() =>
      CatalogReleaseCandidateSchema.parse({ ...candidate, score: 101 }),
    ).toThrow();
    expect(
      CatalogReleaseCandidateSchema.parse({ ...candidate, releaseDate: "1959" })
        .releaseDate,
    ).toBe("1959");
    expect(() =>
      CatalogReleaseCandidateSchema.parse({
        ...candidate,
        releaseDate: "August 1959",
      }),
    ).toThrow();
  });

  it("keeps a label's catalog number attached to the label that issued it", () => {
    expect(
      CatalogLabelSchema.parse({ name: "Columbia", catalogNumber: null }),
    ).toEqual({ name: "Columbia", catalogNumber: null });
    expect(() => CatalogLabelSchema.parse({ name: "" })).toThrow();
  });
});

describe("SearchCatalogReleasesResponseSchema", () => {
  it("returns up to 25 pressings, each with its own reference", () => {
    const response = {
      results: Array.from({ length: 25 }, (_, index) => ({
        ...candidate,
        score: 100 - index,
      })),
    };
    expect(SearchCatalogReleasesResponseSchema.parse(response)).toEqual(
      response,
    );
    expect(() =>
      SearchCatalogReleasesResponseSchema.parse({
        results: [...response.results, candidate],
      }),
    ).toThrow();
  });

  it("accepts an empty result set", () => {
    expect(SearchCatalogReleasesResponseSchema.parse({ results: [] })).toEqual({
      results: [],
    });
  });
});

describe("CatalogTrackSchema", () => {
  it("keeps vinyl-style positions as strings and allows an unknown length", () => {
    expect(
      CatalogTrackSchema.parse({
        position: "B1",
        title: "All Blues",
        lengthMs: null,
      }),
    ).toEqual({ position: "B1", title: "All Blues", lengthMs: null });
    expect(() =>
      CatalogTrackSchema.parse({
        position: "B1",
        title: "All Blues",
        lengthMs: 0,
      }),
    ).toThrow();
  });
});
