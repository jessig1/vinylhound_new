import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

const kindOfBlueGroupId = "8e8a594f-2175-38c7-a871-abb68ec363e7";
const originalPressingId = "d6a1f166-8a02-4608-849b-9d623912c3e5";
const reissuePressingId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const searchResults = [
  {
    reference: {
      provider: "musicbrainz",
      releaseGroupId: kindOfBlueGroupId,
      releaseId: originalPressingId,
      sourceUrl: `https://musicbrainz.org/release/${originalPressingId}`,
      fetchedAt: "2026-09-11T12:00:00.000Z",
    },
    artist: "Miles Davis",
    title: "Kind of Blue",
    releaseDate: "1959-08-17",
    country: "US",
    labels: [{ name: "Columbia", catalogNumber: "CS 8163" }],
    barcode: null,
    formats: ['12" Vinyl'],
    packaging: "Cardboard/Paper Sleeve",
    status: "Official",
    score: 100,
  },
  {
    reference: {
      provider: "musicbrainz",
      releaseGroupId: kindOfBlueGroupId,
      releaseId: reissuePressingId,
      sourceUrl: `https://musicbrainz.org/release/${reissuePressingId}`,
      fetchedAt: "2026-09-11T12:00:00.000Z",
    },
    artist: "Miles Davis",
    title: "Kind of Blue (2015 Reissue)",
    releaseDate: "2015-01-01",
    country: "NL",
    labels: [{ name: "Music on Vinyl", catalogNumber: "MOVLP019" }],
    barcode: "0886976389413",
    formats: ["Vinyl"],
    packaging: "Cardboard/Paper Sleeve",
    status: "Official",
    score: 90,
  },
];

const reissueDetail = {
  ...searchResults[1],
  releaseGroupTitle: "Kind of Blue",
  tracks: [
    { position: "A1", title: "So What", lengthMs: 562_000 },
    { position: "A2", title: "Freddie Freeloader", lengthMs: 590_000 },
  ],
};

test("searches the catalog independently of any scan and shows pressing detail with provenance", async ({
  page,
}) => {
  await page.route("**/api/v1/catalog/releases?**", (route) =>
    route.fulfill({ json: { results: searchResults } }),
  );
  await page.route(`**/api/v1/catalog/releases/${reissuePressingId}`, (route) =>
    route.fulfill({ json: { release: reissueDetail } }),
  );

  await page.goto("/discover");
  await page.getByLabel("Artist").fill("Miles Davis");
  await page.getByLabel("Album title").fill("Kind of Blue");
  await page.getByRole("button", { name: "Search catalog" }).click();

  // Both pressings are grouped under one album heading rather than listed
  // as unrelated results, since they share a release group.
  await expect(page.getByRole("heading", { name: "Kind of Blue" })).toHaveCount(
    1,
  );
  await expect(page.getByText("2 pressings found")).toBeVisible();
  await expect(
    page.getByRole("button", { name: /Kind of Blue \(2015 Reissue\)/ }),
  ).toBeVisible();

  await page
    .getByRole("button", { name: /Kind of Blue \(2015 Reissue\)/ })
    .click();

  const detail = page.locator(".discover-detail");
  await expect(
    detail.getByRole("heading", { name: "Kind of Blue (2015 Reissue)" }),
  ).toBeVisible();
  // The pressing's own title differs from the release group's title, so the
  // panel must say so explicitly rather than implying the cover alone
  // confirms this exact edition.
  await expect(detail).toContainText("differs from the album concept");
  await expect(detail).toContainText("So What");
  await expect(detail).toContainText("9:22");
  await expect(
    detail.getByRole("link", { name: "View on MusicBrainz" }),
  ).toHaveAttribute("href", reissueDetail.reference.sourceUrl);

  const accessibility = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa"])
    .analyze();
  expect(accessibility.violations).toEqual([]);
});

test("reports no results without treating an empty search as an error", async ({
  page,
}) => {
  await page.route("**/api/v1/catalog/releases?**", (route) =>
    route.fulfill({ json: { results: [] } }),
  );

  await page.goto("/discover");
  await page.getByLabel("Artist").fill("Nobody");
  await page.getByLabel("Album title").fill("Nothing At All");
  await page.getByRole("button", { name: "Search catalog" }).click();

  await expect(
    page.getByText("No catalog releases found for that artist and title."),
  ).toBeVisible();
});
