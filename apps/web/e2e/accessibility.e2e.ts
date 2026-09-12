import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

const auditedRoutes = [
  { path: "/dashboard", name: "dashboard" },
  { path: "/scan", name: "scan" },
  { path: "/collection", name: "collection" },
  { path: "/wishlist", name: "wishlist" },
  { path: "/account", name: "account" },
  { path: "/discover", name: "discover" },
  { path: "/favorites", name: "favorites" },
  { path: "/playlists", name: "playlists" },
];

for (const route of auditedRoutes) {
  test(`${route.name} has no WCAG 2 A/AA violations`, async ({ page }) => {
    await page.goto(route.path);
    await expect(page.locator("main")).toBeVisible();

    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa"])
      .analyze();

    expect(results.violations).toEqual([]);
  });
}

test("keyboard navigation exposes a visible focus target", async ({ page }) => {
  // Include a form control: Windows WebKit's default Tab order skips links.
  await page.goto("/collection");
  await page.keyboard.press("Tab");

  await expect(page.locator(":focus-visible")).toHaveCount(1);
});

test("camera and upload controls expose focus on their visible labels", async ({
  page,
}) => {
  await page.goto("/scan");
  for (const input of await page.locator('input[type="file"]').all()) {
    await input.focus();
    await expect(input).toBeFocused();
    await expect(input.locator("..")).toHaveCSS("outline-style", "solid");
    await expect(input.locator("..")).toHaveCSS("outline-width", "3px");
    const target = await input.locator("..").boundingBox();
    expect(target?.height).toBeGreaterThanOrEqual(44);
  }
});

test("scan and library controls fit a narrow phone viewport", async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 780 });
  for (const path of [
    "/scan",
    "/scans",
    "/collection",
    "/discover",
    "/favorites",
    "/playlists",
  ]) {
    await page.goto(path);
    await expect(page.locator("main")).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(360);
  }
});
