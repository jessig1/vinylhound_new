import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

/**
 * Full-library search, keyset pagination and complete export (roadmap P3.4
 * Task 1, ADR-0023). Records are seeded through the real `POST /library`
 * endpoint, one more than a page holds, under an artist unique to this run so
 * the assertions are exact whatever else the e2e account has saved.
 */
const PAGE_SIZE = 50;
const RECORD_COUNT = PAGE_SIZE + 1;

async function seedRecords(page: Page, artist: string) {
  const titles = Array.from(
    { length: RECORD_COUNT },
    (_, index) => `Paged Record ${String(index).padStart(2, "0")}`,
  );
  // Placement is idempotent by identity, so parallel requests are safe; a
  // few at a time keeps the standalone server's pool comfortable.
  for (let start = 0; start < titles.length; start += 8) {
    await Promise.all(
      titles.slice(start, start + 8).map(async (title) => {
        const response = await page.request.post("/api/v1/library", {
          data: {
            artist,
            title,
            releaseYear: 1971,
            label: null,
            catalogNumber: null,
            barcode: null,
            releaseDate: null,
            country: null,
            format: null,
            packaging: null,
            releaseStatus: null,
            catalogReference: null,
            list: "wishlist",
            notes: null,
            copy: null,
          },
        });
        expect(response.ok(), `${title}: ${response.status()}`).toBe(true);
      }),
    );
  }
  return titles;
}

test("shows the next page of a searched list, pages the API without duplicates, and exports every match", async ({
  page,
}) => {
  const artist = `Paged Artist ${Date.now().toString(36)}`;
  const titles = await seedRecords(page, artist);
  const query = encodeURIComponent(artist);

  // The page renders one page of matches and offers the rest.
  await page.goto(`/wishlist?q=${query}`);
  const cards = page.getByRole("link", { name: new RegExp(artist) });
  await expect(cards).toHaveCount(PAGE_SIZE);
  const showMore = page.getByRole("button", { name: "Show more" });
  await expect(showMore).toBeVisible();
  await showMore.click();
  await expect(cards).toHaveCount(RECORD_COUNT);
  await expect(showMore).toHaveCount(0);

  const accessibility = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa"])
    .analyze();
  expect(accessibility.violations).toEqual([]);

  // The API pages by cursor: every record exactly once, in the sort order,
  // with a continuation only while more remain.
  const seen: string[] = [];
  const pageSizes: number[] = [];
  let cursor: string | null = null;
  do {
    const params = new URLSearchParams({
      list: "wishlist",
      q: artist,
      sort: "title",
      limit: "20",
    });
    if (cursor) params.set("cursor", cursor);
    const response = await page.request.get(
      `/api/v1/library?${params.toString()}`,
    );
    expect(response.ok()).toBe(true);
    const body = (await response.json()) as {
      items: { release: { title: string } }[];
      nextCursor: string | null;
    };
    pageSizes.push(body.items.length);
    seen.push(...body.items.map((item) => item.release.title));
    cursor = body.nextCursor;
  } while (cursor);
  expect(pageSizes).toEqual([20, 20, 11]);
  expect(seen).toEqual(titles);

  // A cursor the server cannot read is a bad request, not a server error.
  const rejected = await page.request.get(
    "/api/v1/library?list=wishlist&cursor=not-a-cursor",
  );
  expect(rejected.status()).toBe(400);
  expect(
    ((await rejected.json()) as { error: { code: string } }).error.code,
  ).toBe("invalid_cursor");

  // The export carries every matching record, not only the first page.
  const exported = await page.request.get(
    `/api/v1/library/export?list=wishlist&q=${query}&sort=title`,
  );
  expect(exported.ok()).toBe(true);
  expect(exported.headers()["content-disposition"]).toContain("wishlist.csv");
  const lines = (await exported.text()).split("\r\n").filter(Boolean);
  expect(lines[0]).toBe(
    "artist,title,releaseYear,label,format,country,list,notes,copyCount",
  );
  expect(lines.slice(1).map((line) => line.split(",")[1])).toEqual(titles);
});
