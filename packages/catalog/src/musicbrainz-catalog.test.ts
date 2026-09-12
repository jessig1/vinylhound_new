import { describe, expect, it, vi } from "vitest";

import { createMusicBrainzCatalog } from "./musicbrainz-catalog.ts";

const releaseId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const releaseGroupId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function response(status = 200) {
  return new Response(
    JSON.stringify({
      releases: [
        {
          id: releaseId,
          title: "Kind of Blue",
          score: 98,
          date: "1959-08-17",
          country: "US",
          barcode: null,
          packaging: "Cardboard/Paper Sleeve",
          status: "Official",
          "artist-credit": [{ name: "Miles Davis" }],
          "release-group": { id: releaseGroupId },
          "label-info": [
            { "catalog-number": "CS 8163", label: { name: "Columbia" } },
          ],
          media: [{ format: '12" Vinyl' }],
        },
      ],
    }),
    { status, headers: { "content-type": "application/json" } },
  );
}

describe("MusicBrainz catalog", () => {
  it("searches vinyl releases, normalizes metadata, and caches identical queries", async () => {
    const request = vi.fn(
      async (...requestArguments: Parameters<typeof fetch>) => {
        void requestArguments;
        return response();
      },
    );
    const catalog = createMusicBrainzCatalog({
      userAgent: "VinylHound/0.1.0 (https://vinylhound.test)",
      fetch: request as typeof fetch,
      now: () => Date.parse("2026-08-31T12:00:00.000Z"),
    });

    const first = await catalog.searchReleases({
      artist: "Miles Davis",
      title: "Kind of Blue",
    });
    const second = await catalog.searchReleases({
      artist: "Miles Davis",
      title: "Kind of Blue",
    });

    expect(second).toEqual(first);
    expect(request).toHaveBeenCalledTimes(1);
    const [url, init] = request.mock.calls[0]!;
    expect(String(url)).toContain("format%3Avinyl");
    expect(init?.headers).toMatchObject({
      "user-agent": "VinylHound/0.1.0 (https://vinylhound.test)",
    });
    expect(first).toEqual([
      expect.objectContaining({
        artist: "Miles Davis",
        title: "Kind of Blue",
        releaseDate: "1959-08-17",
        country: "US",
        labels: [{ name: "Columbia", catalogNumber: "CS 8163" }],
        formats: ['12" Vinyl'],
        reference: expect.objectContaining({
          provider: "musicbrainz",
          releaseId,
          releaseGroupId,
        }),
      }),
    ]);
  });

  it("serializes requests, observes the rate limit, and retries transient errors", async () => {
    let clock = 0;
    const sleeps: number[] = [];
    const request = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockImplementation(async () => response());
    const catalog = createMusicBrainzCatalog({
      userAgent: "VinylHound/0.1.0 (https://vinylhound.test)",
      fetch: request as typeof fetch,
      now: () => clock,
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
        clock += milliseconds;
      },
    });

    await catalog.searchReleases({ artist: "Miles Davis", title: "Blue" });
    await catalog.searchReleases({ artist: "Miles Davis", title: "Sketches" });

    expect(request).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([1_000, 1_000]);
  });

  it("fetches a release's full detail with tracks, release-group provenance, and caches it", async () => {
    const request = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            id: releaseId,
            title: "Kind of Blue",
            date: "1959-08-17",
            country: "US",
            barcode: null,
            packaging: "Cardboard/Paper Sleeve",
            status: "Official",
            "artist-credit": [{ name: "Miles Davis" }],
            "release-group": { id: releaseGroupId, title: "Kind of Blue" },
            "label-info": [
              { "catalog-number": "CS 8163", label: { name: "Columbia" } },
            ],
            media: [
              {
                format: '12" Vinyl',
                tracks: [
                  { number: "A1", title: "So What", length: 562_000 },
                  {
                    number: "A2",
                    title: "Freddie Freeloader",
                    length: 590_000,
                  },
                ],
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    const catalog = createMusicBrainzCatalog({
      userAgent: "VinylHound/0.1.0 (https://vinylhound.test)",
      fetch: request as typeof fetch,
      now: () => Date.parse("2026-08-31T12:00:00.000Z"),
    });

    const first = await catalog.getReleaseDetails(releaseId);
    const second = await catalog.getReleaseDetails(releaseId);

    expect(second).toEqual(first);
    expect(request).toHaveBeenCalledTimes(1);
    expect(first).toMatchObject({
      artist: "Miles Davis",
      title: "Kind of Blue",
      releaseGroupTitle: "Kind of Blue",
      reference: {
        provider: "musicbrainz",
        releaseId,
        releaseGroupId,
      },
      tracks: [
        { position: "A1", title: "So What", lengthMs: 562_000 },
        { position: "A2", title: "Freddie Freeloader", lengthMs: 590_000 },
      ],
    });
  });

  it("reports a missing release as not_found without retrying", async () => {
    const request = vi.fn(async () => new Response(null, { status: 404 }));
    const catalog = createMusicBrainzCatalog({
      userAgent: "VinylHound/0.1.0 (https://vinylhound.test)",
      fetch: request as typeof fetch,
      now: () => 0,
    });

    await expect(catalog.getReleaseDetails(releaseId)).rejects.toMatchObject({
      category: "not_found",
      retryable: false,
    });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("rejects a non-UUID release id without making a request", async () => {
    const request = vi.fn();
    const catalog = createMusicBrainzCatalog({
      userAgent: "VinylHound/0.1.0 (https://vinylhound.test)",
      fetch: request as typeof fetch,
    });

    await expect(catalog.getReleaseDetails("not-a-uuid")).rejects.toMatchObject(
      { category: "not_found" },
    );
    expect(request).not.toHaveBeenCalled();
  });
});
