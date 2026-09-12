import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

// Spotify-shaped identifiers: 22 base-62 characters, never UUIDs.
const milesId = "0kbYTNQb4Pb1rPbbaF0pT4";
const kindOfBlueId = "1weenld61qoidwYuZ1GESA";
const sketchesId = "4weenld61qoidwYuZ1GESA";
const soWhatId = "7q3kkfAVpmcZ8g6JUThi3o";

const artist = {
  id: milesId,
  name: "Miles Davis",
  imageUrl: null,
  genres: ["jazz", "bebop"],
  popularity: 74,
  externalUrl: `https://open.spotify.com/artist/${milesId}`,
};

const kindOfBlue = {
  id: kindOfBlueId,
  title: "Kind of Blue",
  artist: "Miles Davis",
  artistIds: [milesId],
  albumType: "album" as const,
  releaseDate: "1959-08-17",
  releaseYear: 1959,
  totalTracks: 5,
  coverUrl: null,
  externalUrl: `https://open.spotify.com/album/${kindOfBlueId}`,
};

const sketches = {
  ...kindOfBlue,
  id: sketchesId,
  title: "Sketches of Spain",
  releaseDate: "1960-07-18",
  releaseYear: 1960,
  externalUrl: `https://open.spotify.com/album/${sketchesId}`,
};

const soWhat = {
  id: soWhatId,
  title: "So What",
  artist: "Miles Davis",
  albumId: kindOfBlueId,
  albumTitle: "Kind of Blue",
  coverUrl: null,
  durationMs: 562_000,
  trackNumber: 1,
  discNumber: 1,
  externalUrl: `https://open.spotify.com/track/${soWhatId}`,
};

const albumDetail = {
  ...kindOfBlue,
  label: "Columbia",
  barcode: "888880668875",
  genres: ["jazz"],
  tracks: [soWhat],
};

/**
 * Never reaches the real Spotify API, matching `scan-flow.e2e.ts`'s existing
 * convention of stubbing every provider call in CI.
 */
async function stubDiscovery(
  page: Page,
  overrides: {
    search?: unknown;
    artist?: unknown;
    album?: unknown;
  } = {},
) {
  await page.route("**/api/v1/discovery/search?**", (route) =>
    route.fulfill({
      json: overrides.search ?? {
        query: "miles davis",
        type: "all",
        artists: [artist],
        albums: [kindOfBlue],
        tracks: [soWhat],
      },
    }),
  );
  await page.route(`**/api/v1/discovery/artists/${milesId}`, (route) =>
    route.fulfill({
      json: overrides.artist ?? {
        artist,
        albums: [sketches, kindOfBlue],
      },
    }),
  );
  await page.route(`**/api/v1/discovery/albums/${kindOfBlueId}`, (route) =>
    route.fulfill({ json: overrides.album ?? { album: albumDetail } }),
  );
}

test("searches artists, albums and tracks from one free-text box", async ({
  page,
}) => {
  await stubDiscovery(page);

  await page.goto("/discover");
  await page
    .getByLabel("Search artists, albums, and tracks")
    .fill("miles davis");

  await expect(page.getByRole("heading", { name: "Artists" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Albums" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Tracks" })).toBeVisible();
  await expect(page.getByText("3 results for “miles davis”.")).toBeVisible();
  await expect(page.getByText("9:22")).toBeVisible();

  const accessibility = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa"])
    .analyze();
  expect(accessibility.violations).toEqual([]);
});

test("keeps the query in the URL so a search can be shared and reopened", async ({
  page,
}) => {
  await stubDiscovery(page);

  await page.goto("/discover");
  await page
    .getByLabel("Search artists, albums, and tracks")
    .fill("miles davis");
  await expect(page).toHaveURL(/\/discover\?q=miles%20davis/);

  // Reopening that URL restores the search rather than an empty page.
  await page.goto("/discover?q=miles%20davis");
  await expect(
    page.getByLabel("Search artists, albums, and tracks"),
  ).toHaveValue("miles davis");
  await expect(page.getByRole("heading", { name: "Albums" })).toBeVisible();
});

test("walks search to artist discography to album tracklist", async ({
  page,
}) => {
  await stubDiscovery(page);

  await page.goto("/discover?q=miles%20davis");
  await page
    .getByRole("link", { name: /Miles Davis/ })
    .first()
    .click();

  await expect(
    page.getByRole("heading", { level: 1, name: "Miles Davis" }),
  ).toBeVisible();
  // Newest first, grouped by release type rather than one flat list.
  await expect(page.getByRole("heading", { name: "Albums" })).toBeVisible();
  await expect(page.getByText("2 releases")).toBeVisible();

  await page.getByRole("link", { name: /Kind of Blue/ }).click();

  await expect(
    page.getByRole("heading", { level: 1, name: "Kind of Blue" }),
  ).toBeVisible();
  await expect(page.getByText("So What")).toBeVisible();
  // The label reaches the page from the album lookup, shown as its own fact.
  await expect(
    page.getByRole("definition").filter({ hasText: "Columbia" }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Open on Spotify" }),
  ).toHaveAttribute("href", albumDetail.externalUrl);

  const accessibility = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa"])
    .analyze();
  expect(accessibility.violations).toEqual([]);
});

test("saves a discovered album to the library and says what it cannot prove", async ({
  page,
}) => {
  await stubDiscovery(page);

  let placed: Record<string, unknown> | null = null;
  await page.route("**/api/v1/library", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    placed = route.request().postDataJSON() as Record<string, unknown>;
    return route.fulfill({
      status: 201,
      json: {
        release: {
          id: "11111111-1111-4111-8111-111111111111",
          artist: "Miles Davis",
          title: "Kind of Blue",
          releaseYear: 1959,
          label: "Columbia",
          catalogNumber: null,
          barcode: "888880668875",
          releaseDate: "1959-08-17",
          country: null,
          format: null,
          packaging: null,
          releaseStatus: null,
          catalogReference: {
            provider: "spotify",
            releaseGroupId: kindOfBlueId,
            releaseId: null,
            sourceUrl: albumDetail.externalUrl,
            fetchedAt: "2026-09-11T12:00:00.000Z",
          },
        },
        libraryItem: {
          id: "22222222-2222-4222-8222-222222222222",
          list: "collection",
          notes: null,
          copy: null,
        },
        placedAt: "2026-09-11T12:00:00.000Z",
      },
    });
  });

  await page.goto(`/discover/albums/${kindOfBlueId}`);

  // The page states plainly that a streaming match is not pressing evidence.
  await expect(
    page.getByText(/Spotify identifies the album, never the pressing/),
  ).toBeVisible();

  await page.getByRole("button", { name: "Add to collection" }).click();
  await expect(page.getByText(/Saved to your collection/)).toBeVisible();

  // The saved record must not invent pressing fields Spotify cannot answer,
  // and its reference must not claim a pressing.
  expect(placed).toMatchObject({
    artist: "Miles Davis",
    title: "Kind of Blue",
    label: "Columbia",
    barcode: "888880668875",
    catalogNumber: null,
    country: null,
    format: null,
    packaging: null,
    releaseStatus: null,
    list: "collection",
    catalogReference: { provider: "spotify", releaseId: null },
  });
});

test("explains an unconfigured deployment instead of showing an error", async ({
  page,
}) => {
  await page.route("**/api/v1/discovery/search?**", (route) =>
    route.fulfill({
      status: 503,
      json: {
        error: {
          code: "discovery_not_configured",
          message: "Discovery is not configured for this deployment.",
          requestId: "00000000-0000-4000-8000-000000000000",
        },
      },
    }),
  );

  await page.goto("/discover");
  await page.getByLabel("Search artists, albums, and tracks").fill("miles");

  // The server's own explanation is shown, not fixed copy: "no credentials
  // configured" and "Spotify refused these credentials" need different fixes.
  await expect(
    page.getByText(/Discovery is not configured for this deployment/),
  ).toBeVisible();
});

test("reports an empty result set without treating it as a failure", async ({
  page,
}) => {
  await stubDiscovery(page, {
    search: {
      query: "nothing at all",
      type: "all",
      artists: [],
      albums: [],
      tracks: [],
    },
  });

  await page.goto("/discover");
  await page
    .getByLabel("Search artists, albums, and tracks")
    .fill("nothing at all");

  await expect(page.getByText(/Nothing found for/)).toBeVisible();
});
