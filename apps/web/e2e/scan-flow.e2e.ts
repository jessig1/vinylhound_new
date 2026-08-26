import { expect, test } from "@playwright/test";
import sharp from "sharp";

// The upload input without the capture attribute is the "Upload image" path;
// the capture input is reserved for the camera.
const uploadInput = 'input[type="file"]:not([capture])';

let coverJpeg: Buffer;

test.beforeAll(async () => {
  coverJpeg = await sharp({
    create: { width: 512, height: 512, channels: 3, background: "#7a2c1d" },
  })
    .jpeg()
    .toBuffer();
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
