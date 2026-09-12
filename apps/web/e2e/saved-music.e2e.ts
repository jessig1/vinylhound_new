import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

/**
 * Favorites and playlists over saved records, with no scan involved
 * (roadmap P3.3 Task 2). Records are seeded through the real `POST /library`
 * placement endpoint against the e2e database, exactly as `/discover`
 * saves them, so every step below runs against real persistence.
 */
async function placeRecord(
  page: Page,
  input: { title: string; list: "collection" | "wishlist" },
) {
  const response = await page.request.post("/api/v1/library", {
    data: {
      artist: "Saved Music Browser Test",
      title: input.title,
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
      list: input.list,
      notes: null,
      copy: null,
    },
  });
  expect(response.ok()).toBe(true);
  const body = (await response.json()) as { libraryItem: { id: string } };
  return body.libraryItem.id;
}

test("favorites a saved record and lists it across both lists", async ({
  page,
}) => {
  const unique = Date.now().toString(36);
  const title = `Starred ${unique}`;
  const itemId = await placeRecord(page, { title, list: "wishlist" });

  await page.goto(`/library/${itemId}`);
  await page.getByRole("button", { name: "Add to favorites" }).click();
  await expect(
    page.getByRole("button", { name: "Remove from favorites" }),
  ).toBeVisible();

  // A wishlist record shows up on the favorites page: a favorite is an
  // attribute of the saved record, not a third list.
  await page.goto("/favorites");
  const card = page.getByRole("link", { name: new RegExp(title) });
  await expect(card).toBeVisible();
  await expect(card.getByText("Favorite")).toBeAttached();

  const accessibility = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa"])
    .analyze();
  expect(accessibility.violations).toEqual([]);

  await page.goto(`/library/${itemId}`);
  await page.getByRole("button", { name: "Remove from favorites" }).click();
  await expect(
    page.getByRole("button", { name: "Add to favorites" }),
  ).toBeVisible();

  await page.goto("/favorites");
  await expect(page.getByRole("link", { name: new RegExp(title) })).toHaveCount(
    0,
  );
});

test("creates, fills, reorders, renames, and deletes a playlist", async ({
  page,
}) => {
  const unique = Date.now().toString(36);
  const alpha = `Alpha ${unique}`;
  const beta = `Beta ${unique}`;
  const playlistName = `Road trip ${unique}`;
  const alphaId = await placeRecord(page, { title: alpha, list: "collection" });
  const betaId = await placeRecord(page, { title: beta, list: "wishlist" });

  await page.goto("/playlists");
  await page.getByLabel("Playlist name").fill(playlistName);
  await page.getByRole("button", { name: "Create playlist" }).click();
  await page.waitForURL(/\/playlists\/[0-9a-f-]{36}$/);
  await expect(
    page.getByRole("heading", { level: 1, name: playlistName }),
  ).toBeVisible();
  await expect(page.getByText("This playlist is empty.")).toBeVisible();
  const playlistUrl = page.url();

  // Records join a playlist from their own page, in the order added.
  for (const itemId of [alphaId, betaId]) {
    await page.goto(`/library/${itemId}`);
    await page
      .getByRole("combobox", { name: "Playlist" })
      .selectOption({ label: playlistName });
    await page.getByRole("button", { name: "Add to playlist" }).click();
    await expect(page.getByText(`Added to ${playlistName}.`)).toBeVisible();
    await expect(
      page.getByRole("link", { name: playlistName, exact: true }),
    ).toBeVisible();
  }

  await page.goto(playlistUrl);
  const entries = page.locator(".playlist-entry");
  await expect(entries).toHaveCount(2);
  await expect(entries.nth(0)).toContainText(alpha);
  await expect(entries.nth(1)).toContainText(beta);

  // Reorder, then reload to prove the order was persisted, not just drawn.
  await page.getByRole("button", { name: `Move ${beta} up` }).click();
  await expect(entries.nth(0)).toContainText(beta);
  await page.reload();
  await expect(page.locator(".playlist-entry").nth(0)).toContainText(beta);
  await expect(page.locator(".playlist-entry").nth(1)).toContainText(alpha);

  await page
    .getByRole("button", { name: `Remove ${alpha} from this playlist` })
    .click();
  await expect(page.locator(".playlist-entry")).toHaveCount(1);
  await expect(page.locator(".playlist-entry").nth(0)).toContainText(beta);

  const renamed = `Sunday ${unique}`;
  await page.getByLabel("Playlist name").fill(renamed);
  await page.getByRole("button", { name: "Rename" }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: renamed }),
  ).toBeVisible();

  const accessibility = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa"])
    .analyze();
  expect(accessibility.violations).toEqual([]);

  // The list index shows the renamed playlist with its count.
  await page.goto("/playlists");
  const listed = page.getByRole("link", { name: new RegExp(renamed) });
  await expect(listed).toBeVisible();
  await expect(listed).toContainText("1 record");

  await page.goto(playlistUrl);
  await page.getByRole("button", { name: "Delete playlist" }).click();
  await page.getByRole("button", { name: "Yes, delete it" }).click();
  await page.waitForURL(/\/playlists$/);
  await expect(
    page.getByRole("link", { name: new RegExp(renamed) }),
  ).toHaveCount(0);

  // Deleting the playlist never deletes the saved records in it.
  await page.goto(`/library/${betaId}`);
  await expect(
    page.getByRole("heading", { level: 1, name: beta }),
  ).toBeVisible();
  await expect(
    page.getByText("This record is not in any playlist yet."),
  ).toBeVisible();
});
