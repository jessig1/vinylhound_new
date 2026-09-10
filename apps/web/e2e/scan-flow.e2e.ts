import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import sharp from "sharp";

const uploadInput = 'input[aria-label="Upload photos"]';

let coverJpeg: Buffer;
let backJpeg: Buffer;
let spineJpeg: Buffer;

test.beforeAll(async () => {
  coverJpeg = await sharp({
    create: { width: 512, height: 512, channels: 3, background: "#7a2c1d" },
  })
    .jpeg()
    .toBuffer();
  backJpeg = await sharp({
    create: { width: 512, height: 512, channels: 3, background: "#2c3e7a" },
  })
    .jpeg()
    .toBuffer();
  spineJpeg = await sharp({
    create: { width: 128, height: 512, channels: 3, background: "#3e7a2c" },
  })
    .jpeg()
    .toBuffer();
});

test("uploads selected cover photos as independently trackable records", async ({
  page,
}) => {
  await page.goto("/scan");
  await page.setInputFiles(uploadInput, [
    { name: "front.jpg", mimeType: "image/jpeg", buffer: coverJpeg },
    { name: "back.jpg", mimeType: "image/jpeg", buffer: backJpeg },
    { name: "spine.jpg", mimeType: "image/jpeg", buffer: spineJpeg },
  ]);

  await expect(page.getByText("3 records in this session")).toBeVisible();
  await expect(page.getByText("Record 1")).toBeVisible();
  await expect(page.locator(".view-card select")).toHaveCount(0);

  await page.getByRole("button", { name: "Start capture session" }).click();

  await page.waitForURL(/\/scans\/batch\/[0-9a-f-]{36}/, { timeout: 30_000 });
  await expect(page.getByText("Matched")).toHaveCount(3, { timeout: 30_000 });
  const firstScanId = await page
    .locator(".batch-scan-card")
    .first()
    .getAttribute("data-scan-id");
  await page.goto(`/scans/${firstScanId}`);
  await page.waitForURL(/\/scans\/[0-9a-f-]{36}/, { timeout: 30_000 });
  await expect(
    page.getByRole("heading", { name: "Check the match." }),
  ).toBeVisible({ timeout: 30_000 });
  // Results that arrive through polling must populate the form without a reload.
  await expect(page.getByLabel("Artist")).toHaveValue("The Vinyl Hounds");
  await expect(page.getByLabel("Album title")).toHaveValue(
    "Automated Test Pressing",
  );

  // Force a queued response before the real result to exercise asynchronous
  // draft initialization even when the synthetic worker finishes quickly.
  let firstPoll = true;
  await page.route(/\/api\/v1\/scans\/[0-9a-f-]{36}$/, async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    if (firstPoll) {
      firstPoll = false;
      await route.fulfill({
        json: { ...body, status: "queued", candidates: [], attempt: null },
      });
    } else {
      await route.fulfill({ response });
    }
  });
  await page.reload();
  await expect(page.getByLabel("Artist")).toHaveValue("The Vinyl Hounds");
  await expect(page.getByLabel("Album title")).toHaveValue(
    "Automated Test Pressing",
  );

  await page.route("**/api/v1/catalog/releases?**", (route) =>
    route.fulfill({ json: { results: [] } }),
  );
  await page.getByRole("button", { name: "Search MusicBrainz" }).click();
  await expect(page.getByRole("status")).toContainText(
    "No catalog releases found",
  );
  const accessibility = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa"])
    .analyze();
  expect(accessibility.violations).toEqual([]);

  // A retry must resume GET polling after a terminal result. Stub the retry
  // boundary so this regression does not submit another analysis job.
  await page.unroute(/\/api\/v1\/scans\/[0-9a-f-]{36}$/);
  let retryRequested = false;
  await page.route(/\/api\/v1\/scans\/[0-9a-f-]{36}$/, async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({
      json: retryRequested ? body : { ...body, status: "unresolved" },
    });
  });
  await page.route("**/retry", async (route) => {
    retryRequested = true;
    const scanId = new URL(page.url()).pathname.split("/").at(-1);
    await route.fulfill({
      json: {
        scanId,
        status: "queued",
        attemptNumber: 2,
        jobId: "ui-retry-check",
      },
    });
  });
  await page.reload();
  await page.getByRole("button", { name: "retry this scan" }).click();
  await expect(page.getByLabel("Artist")).toHaveValue("The Vinyl Hounds");
  await expect(page.getByText("High confidence")).toBeVisible();
});

test("groups two front-cover photos into an independently trackable batch", async ({
  page,
}) => {
  await page.goto("/scan");

  await expect(page.getByLabel("Upload photos")).toHaveAttribute(
    "multiple",
    "",
  );

  await page.setInputFiles(uploadInput, [
    { name: "record-a.jpg", mimeType: "image/jpeg", buffer: coverJpeg },
    { name: "record-b.jpg", mimeType: "image/jpeg", buffer: backJpeg },
  ]);

  await expect(page.getByText("2 records in this session")).toBeVisible();
  await expect(page.locator(".view-card select")).toHaveCount(0);

  await page.getByRole("button", { name: "Start capture session" }).click();

  await page.waitForURL(/\/scans\/batch\/[0-9a-f-]{36}/, { timeout: 30_000 });
  await expect(page.getByRole("heading", { name: "2 records" })).toBeVisible();
  await expect(page.getByText("Matched")).toHaveCount(2, { timeout: 30_000 });
  await expect(
    page.getByText("All records in this batch have finished."),
  ).toBeVisible();

  const secondBatchScanId = await page
    .locator(".batch-scan-card")
    .first()
    .getAttribute("data-scan-id");
  await page.goto(`/scans/${secondBatchScanId}`);
  await page.waitForURL(/\/scans\/[0-9a-f-]{36}/, { timeout: 30_000 });
  await expect(
    page.getByRole("heading", { name: "Check the match." }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "View batch progress" }),
  ).toBeVisible();
});

test("identifies a misnamed cover photo and confirms it into the collection", async ({
  page,
}) => {
  await page.goto("/scan");

  // JPEG bytes under a .webp name: the browser reports image/webp, the client
  // must sniff the real format (regression for the upload MIME fix).
  await page.setInputFiles(uploadInput, {
    name: "cover-art.webp",
    mimeType: "image/webp",
    buffer: coverJpeg,
  });
  await page.getByRole("button", { name: "Start capture session" }).click();

  await page.waitForURL(/\/scans\/batch\/[0-9a-f-]{36}/, { timeout: 30_000 });
  const finalBatchId = new URL(page.url()).pathname.split("/").at(-1);
  const finalScanId = await page
    .locator(".batch-scan-card")
    .first()
    .getAttribute("data-scan-id");
  await page.goto(`/scans/${finalScanId}`);
  await page.waitForURL(/\/scans\/[0-9a-f-]{36}/, { timeout: 30_000 });
  await expect(
    page.getByRole("heading", { name: "Check the match." }),
  ).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("High confidence")).toBeVisible();
  await expect(
    page.getByRole("button", { name: /Automated Test Pressing/ }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /Alternate Take/ }),
  ).toBeVisible();
  await expect(page.getByLabel("Artist")).toHaveValue("The Vinyl Hounds");
  await expect(page.getByLabel("Storage location")).toBeHidden();
  await page.getByText("Copy details (optional)", { exact: true }).click();
  await page.getByLabel("Storage location").fill("Listening room");
  await page.getByText("Copy details (optional)", { exact: true }).click();
  await expect(page.getByLabel("Storage location")).toHaveValue(
    "Listening room",
  );

  // The scan is refresh-safe: reloading recovers the same reviewable state.
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Check the match." }),
  ).toBeVisible();
  await expect(page.getByLabel("Artist")).toHaveValue("The Vinyl Hounds");
  await expect(page.getByLabel("Album title")).toHaveValue(
    "Automated Test Pressing",
  );

  await page
    .getByRole("button", { name: "Confirm and add to collection" })
    .click();
  await expect(
    page.getByRole("heading", { name: "Automated Test Pressing" }),
  ).toBeVisible();
  await expect(page.getByText("Added to your collection")).toBeVisible();

  await page.getByRole("link", { name: "View collection" }).click();
  await page.waitForURL(/\/collection/);
  await expect(
    page.getByRole("heading", { name: "Automated Test Pressing" }),
  ).toBeVisible();
  await expect(page.getByText("The Vinyl Hounds")).toBeVisible();

  // Scan rows remain navigable at phone widths, including after confirmation.
  await page.goto("/dashboard");
  await page.locator(`a.scan-row[href="/scans/batch/${finalBatchId}"]`).click();
  await expect(page.getByRole("heading", { name: "1 record" })).toBeVisible();
  await page.goto("/scans");
  await page.locator(`a.scan-row[href="/scans/batch/${finalBatchId}"]`).click();
  await expect(page.getByRole("heading", { name: "1 record" })).toBeVisible();
});

test("empty library search can be cleared without changing sort", async ({
  page,
}) => {
  await page.goto("/collection?q=no-such-record-ui-check&sort=artist");
  await expect(
    page.getByRole("heading", { name: "No matching records." }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Clear search" }).click();
  await expect(
    page.getByRole("textbox", { name: "Search your collection" }),
  ).toHaveValue("");
  await expect(page.getByRole("combobox", { name: "Sort" })).toHaveValue(
    "artist",
  );
});

test("rejects a file whose bytes are not an image before uploading", async ({
  page,
}) => {
  await page.goto("/scan");
  await page.setInputFiles(uploadInput, {
    name: "cover.webp",
    mimeType: "image/webp",
    buffer: Buffer.from("These bytes are plain text, not an image."),
  });
  await page.getByRole("button", { name: "Start capture session" }).click();

  await expect(page.locator("p.form-error")).toContainText(
    "not a JPEG, PNG, WebP, or GIF",
  );
  expect(new URL(page.url()).pathname).toBe("/scan");
});

test("explains HEIC phone photos before uploading", async ({ page }) => {
  const heic = Buffer.concat([
    Buffer.from([0x00, 0x00, 0x00, 0x18]),
    Buffer.from("ftypheic"),
    Buffer.alloc(8),
  ]);
  await page.goto("/scan");
  await page.setInputFiles(uploadInput, {
    name: "photo.heic",
    mimeType: "image/heic",
    buffer: heic,
  });
  await page.getByRole("button", { name: "Start capture session" }).click();

  await expect(page.locator("p.form-error")).toContainText("HEIC");
  expect(new URL(page.url()).pathname).toBe("/scan");
});
