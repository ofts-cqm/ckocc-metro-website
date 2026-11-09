import { expect, test } from "playwright/test";
import bootstrap from "../../public/maps/bootstrap.json";
import { catalogs } from "../../src/lib/i18n/catalogs";

test.beforeEach(async ({ page }) => {
  await page.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    return route.fulfill({
      json:
        path === "/api/auth/session"
          ? { user: null }
          : path === "/api/map"
            ? { map: bootstrap, source: "bootstrap" }
            : { issues: [], page: 1, hasMore: false },
    });
  });
});

test("system follows device changes; explicit choice persists in server HTML", async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/en-us");
  await expect(page.locator("html")).toHaveCSS("color-scheme", "dark");
  await expect(page.locator("body")).toHaveCSS(
    "background-color",
    "rgb(20, 14, 16)",
  );
  await page.emulateMedia({ colorScheme: "light" });
  await expect(page.locator("html")).toHaveCSS("color-scheme", "light");
  await page.locator(".theme-desktop select").selectOption("dark");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.locator(".theme-desktop select")).toHaveValue("dark");
  const html = await (await page.request.get("/en-us")).text();
  expect(html).toContain('data-theme="dark"');
  await page.locator(".theme-desktop select").selectOption("light");
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveCSS("color-scheme", "light");
  await page.locator(".theme-desktop select").selectOption("system");
  await expect(page.locator("html")).toHaveCSS("color-scheme", "dark");
  await expect(page.locator(".map-canvas")).toHaveCSS(
    "background-color",
    "rgb(255, 255, 255)",
  );
});

for (const locale of ["en-us", "zh-cn", "zh-hk"] as const) {
  test(`${locale}: mobile theme control is accessible and fits at 320px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 320, height: 900 });
    await page.goto(`/${locale}`);
    await page
      .getByRole("button", { name: catalogs[locale].menu, exact: true })
      .click();
    await page
      .locator(".theme-mobile")
      .getByRole("combobox", { name: catalogs[locale].theme })
      .selectOption("dark");
    await expect(page.locator("html")).toHaveCSS("color-scheme", "dark");
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page
      .getByRole("button", { name: catalogs[locale].menu, exact: true })
      .click();
    await expect(page.locator(".mobile-nav")).toHaveCount(0);
  });
}
