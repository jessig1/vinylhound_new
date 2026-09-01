import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

const auditedRoutes = [
  { path: "/dashboard", name: "dashboard" },
  { path: "/scan", name: "scan" },
  { path: "/collection", name: "collection" },
  { path: "/wishlist", name: "wishlist" },
  { path: "/account", name: "account" },
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
  await page.goto("/dashboard");
  await page.keyboard.press("Tab");

  await expect(page.locator(":focus-visible")).toHaveCount(1);
});
