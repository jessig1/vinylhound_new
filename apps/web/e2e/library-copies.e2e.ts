import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

/**
 * Per-copy editing on the library item detail page and the last-copy rule
 * (roadmap P3.4 Task 2, ADR-0024). The record is seeded through the real
 * `POST /library` placement endpoint, which records the first copy exactly
 * as a scan confirmation would, so every step runs against real persistence.
 */
async function placeOwnedRecord(page: Page, title: string) {
  const response = await page.request.post("/api/v1/library", {
    data: {
      artist: "Copy Rules Browser Test",
      title,
      releaseYear: 1977,
      label: null,
      catalogNumber: null,
      barcode: null,
      releaseDate: null,
      country: null,
      format: null,
      packaging: null,
      releaseStatus: null,
      catalogReference: null,
      list: "collection",
      notes: null,
      copy: null,
    },
  });
  expect(response.ok()).toBe(true);
  const body = (await response.json()) as {
    libraryItem: { id: string; copy: { id: string } | null };
  };
  return { itemId: body.libraryItem.id, copyId: body.libraryItem.copy!.id };
}

function copyEditor(page: Page, index: number) {
  return page.locator("details.copy-editor").filter({
    has: page.locator("summary strong", { hasText: `Copy ${index}` }),
  });
}

test("edits, adds and removes copies, keeps the record owned after the last one, and moves it only then", async ({
  page,
}) => {
  const title = `Copy Rules ${Date.now().toString(36)}`;
  const { itemId } = await placeOwnedRecord(page, title);

  await page.goto(`/library/${itemId}`);
  await expect(page.getByRole("heading", { name: title })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "1 physical copy" }),
  ).toBeVisible();

  // Grade and place the first copy; the saved state is what the server kept.
  const first = copyEditor(page, 1);
  await first.locator("summary").click();
  await first.getByLabel("Media condition").selectOption("very_good_plus");
  await first.getByLabel("Storage location").fill("  Shelf E2E ");
  await first.getByLabel("Acquired on").fill("2026-08-30");
  await first.getByLabel("Copy notes").fill("Insert included");
  await first.getByRole("button", { name: "Save copy" }).click();
  await expect(first.getByText("Copy saved.")).toBeVisible();
  await expect(first.getByLabel("Storage location")).toHaveValue("Shelf E2E");
  // The button re-enables once the router refresh has landed; reloading
  // while that refresh is in flight aborts the navigation on Firefox.
  await expect(first.getByRole("button", { name: "Save copy" })).toBeEnabled();

  await page.reload();
  await expect(copyEditor(page, 1).locator("summary")).toContainText(
    "Media Very Good Plus · Shelf E2E · Acquired 2026-08-30",
  );

  // A second pressing is recorded explicitly.
  await page.getByRole("button", { name: "Add another copy" }).click();
  await expect(page.getByText("Copy added.")).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "2 physical copies" }),
  ).toBeVisible();
  const second = copyEditor(page, 2);
  await expect(second).toBeVisible();

  // Removing one of two asks, then leaves the other.
  await second.locator("summary").click();
  await second.getByRole("button", { name: "Remove copy" }).click();
  await expect(second.getByText("Remove copy 2?")).toBeVisible();
  await second.getByRole("button", { name: "Yes, remove copy 2" }).click();
  await expect(
    page.getByRole("heading", { name: "1 physical copy" }),
  ).toBeVisible();
  await expect(copyEditor(page, 2)).toHaveCount(0);

  // The last copy can be removed; the confirmation says the record stays
  // owned, and afterwards the page says so and offers the way back.
  const last = copyEditor(page, 1);
  await last.locator("summary").click();
  await last.getByRole("button", { name: "Remove copy" }).click();
  await expect(last.getByText("This is the only copy recorded.")).toBeVisible();
  await last.getByRole("button", { name: "Yes, remove copy 1" }).click();
  await expect(
    page.getByRole("heading", { name: "No copies recorded" }),
  ).toBeVisible();
  await expect(
    page.getByText("Every copy of this record has been removed."),
  ).toBeVisible();
  await expect(
    page.getByText("In your collection", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Add a copy" })).toBeVisible();

  const accessibility = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa"])
    .analyze();
  expect(accessibility.violations).toEqual([]);

  // With nothing left to orphan, the ADR-0011 move to the wishlist works,
  // and moving back records a first copy again.
  const moveToWishlist = page.getByRole("button", { name: "Move to wishlist" });
  await expect(moveToWishlist).toBeEnabled();
  await moveToWishlist.click();
  await expect(
    page.getByText("On your wishlist", { exact: true }),
  ).toBeVisible();
  // The move settles: feedback lands and the buttons come back enabled.
  await expect(page.getByText("Moved to your wishlist.")).toBeVisible();
  await expect(page.getByRole("heading", { name: /copies|copy/ })).toHaveCount(
    0,
  );
  await page.getByRole("button", { name: "I own this now" }).click();
  await expect(
    page.getByText("In your collection", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Moved to your collection.")).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "1 physical copy" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Move to wishlist" }),
  ).toBeDisabled();
});

test("adds a copy once per idempotency key and refuses a copy it cannot resolve", async ({
  page,
}) => {
  const { itemId, copyId } = await placeOwnedRecord(
    page,
    `Copy Keys ${Date.now().toString(36)}`,
  );
  const url = `/api/v1/library/${itemId}/copies`;

  // The request needs a key: a copy has no identity to converge on.
  const unkeyed = await page.request.post(url, { data: {} });
  expect(unkeyed.status()).toBe(400);
  expect(
    ((await unkeyed.json()) as { error: { code: string } }).error.code,
  ).toBe("invalid_idempotency_key");

  const key = `e2e-copy-${Date.now().toString(36)}`;
  const created = await page.request.post(url, {
    data: { location: "Crate 9" },
    headers: { "idempotency-key": key },
  });
  expect(created.status()).toBe(201);
  const copy = (await created.json()) as { id: string; location: string };
  expect(copy.location).toBe("Crate 9");

  // Replaying the key returns the same copy; changing the body under it is
  // refused rather than recorded twice.
  const replayed = await page.request.post(url, {
    data: { location: "Crate 9" },
    headers: { "idempotency-key": key },
  });
  expect(replayed.status()).toBe(200);
  expect(((await replayed.json()) as { id: string }).id).toBe(copy.id);
  const changed = await page.request.post(url, {
    data: { location: "Crate 10" },
    headers: { "idempotency-key": key },
  });
  expect(changed.status()).toBe(409);
  expect(
    ((await changed.json()) as { error: { code: string } }).error.code,
  ).toBe("conflict");

  const listed = await page.request.get(
    `/api/v1/library?list=collection&q=${encodeURIComponent("Copy Keys")}`,
  );
  const record = (
    (await listed.json()) as {
      items: { id: string; copyCount: number; copies: { id: string }[] }[];
    }
  ).items.find((item) => item.id === itemId);
  expect(record?.copyCount).toBe(2);
  expect(record?.copies.map((entry) => entry.id)).toEqual([copyId, copy.id]);

  // Removal is idempotent by identity: the second attempt finds nothing.
  const removed = await page.request.delete(`${url}/${copy.id}`);
  expect(removed.status()).toBe(200);
  const again = await page.request.delete(`${url}/${copy.id}`);
  expect(again.status()).toBe(404);
  const edited = await page.request.patch(`${url}/${copy.id}`, {
    data: { notes: "gone" },
  });
  expect(edited.status()).toBe(404);
});
