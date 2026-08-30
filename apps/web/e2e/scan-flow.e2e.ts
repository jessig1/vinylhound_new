import { expect, test } from "@playwright/test";
import sharp from "sharp";

// The upload input without the capture attribute is the "Upload image" path;
// the capture input is reserved for the camera.
const uploadInput = 'input[type="file"]:not([capture])';

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

test("groups front, back, and spine photos into one labeled multi-view scan", async ({
  page,
}) => {
  await page.goto("/scan");

  await page.setInputFiles(uploadInput, [
    { name: "front.jpg", mimeType: "image/jpeg", buffer: coverJpeg },
    { name: "back.jpg", mimeType: "image/jpeg", buffer: backJpeg },
    { name: "spine.jpg", mimeType: "image/jpeg", buffer: spineJpeg },
  ]);

  await expect(page.getByText("3 views of one record")).toBeVisible();
  const viewSelects = page.locator(".view-card select");
  await expect(viewSelects).toHaveCount(3);
  await expect(viewSelects.nth(0)).toHaveValue("front");
  await expect(viewSelects.nth(1)).toHaveValue("back");
  await expect(viewSelects.nth(2)).toHaveValue("spine");

  await page.getByRole("button", { name: "Identify album" }).click();

  await page.waitForURL(/\/scans\/[0-9a-f-]{36}/, { timeout: 30_000 });
  await expect(
    page.getByRole("heading", { name: "Check the match." }),
  ).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("combined 3 labeled views")).toBeVisible();
});

test("groups two front-cover photos into an independently trackable batch", async ({
  page,
}) => {
  await page.goto("/scan");
  await page.getByRole("button", { name: "Multiple records" }).click();

  await page.setInputFiles(uploadInput, [
    { name: "record-a.jpg", mimeType: "image/jpeg", buffer: coverJpeg },
    { name: "record-b.jpg", mimeType: "image/jpeg", buffer: backJpeg },
  ]);

  await expect(page.getByText("2 records in this batch")).toBeVisible();
  await expect(page.locator(".view-card select")).toHaveCount(0);

  await page.getByRole("button", { name: "Identify all records" }).click();

  await page.waitForURL(/\/scans\/batch\/[0-9a-f-]{36}/, { timeout: 30_000 });
  await expect(page.getByRole("heading", { name: "2 records" })).toBeVisible();
  await expect(page.getByText("Matched")).toHaveCount(2, { timeout: 30_000 });
  await expect(
    page.getByText("All records in this batch have finished."),
  ).toBeVisible();

  await page.getByRole("link", { name: "Review" }).first().click();
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
  await page.getByRole("button", { name: "Identify album" }).click();

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
  await page.getByRole("button", { name: "Identify album" }).click();

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
  await page.getByRole("button", { name: "Identify album" }).click();

  await expect(page.locator("p.form-error")).toContainText("HEIC");
  expect(new URL(page.url()).pathname).toBe("/scan");
});
