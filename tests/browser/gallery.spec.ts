import { expect, test } from "playwright/test";
import bootstrap from "../../public/maps/bootstrap.json";
import { catalogs } from "../../src/lib/i18n/catalogs";
import { galleryImage, galleryPhotos } from "../../src/lib/gallery";

test.beforeEach(async ({ page }) => {
  await page.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    const responses: Record<string, unknown> = {
      "/api/auth/session": { user: null },
      "/api/map": { map: bootstrap, source: "bootstrap" },
      "/api/issues": { issues: [], page: 1, hasMore: false },
    };
    if (!(path in responses))
      throw new Error(`Unexpected API request: ${path}`);
    return route.fulfill({ json: responses[path] });
  });
});

test("gallery rotates, wraps manually, and pauses for hover, focus, and the pause control", async ({
  page,
}) => {
  await page.clock.install();
  await page.goto("/en-us");
  const gallery = page.locator("#gallery");
  const counter = gallery.locator(".gallery-counter");
  await expect(page.locator(".below-map + #gallery")).toBeAttached();
  await expect(gallery.getByRole("img")).toHaveCount(1);
  await expect(counter).toHaveText("1 / 17");
  await expect(
    gallery.getByRole("button", { name: "Pause slideshow" }),
  ).toBeVisible();
  const firstPhoto = await gallery.getByRole("img").getAttribute("src");
  await page.clock.runFor(6100);
  await expect(counter).toHaveText("2 / 17");
  await expect(gallery.getByRole("img")).not.toHaveAttribute(
    "src",
    firstPhoto!,
  );
  await gallery.getByRole("button", { name: "Previous photo" }).click();
  await expect(counter).toHaveText("1 / 17");
  await expect(gallery.getByRole("img")).toHaveAttribute("src", firstPhoto!);
  await gallery.getByRole("button", { name: "Previous photo" }).click();
  await expect(counter).toHaveText("17 / 17");
  await gallery.getByRole("button", { name: "Next photo" }).click();
  await expect(counter).toHaveText("1 / 17");
  await page.mouse.move(0, 0);
  await page.clock.runFor(12000);
  await expect(counter).toHaveText("1 / 17"); // Keyboard focus pauses rotation.
  await page.getByRole("heading", { name: "Gallery", exact: true }).click();
  await gallery.locator(".gallery-photo-link").hover();
  await page.clock.runFor(12000);
  await expect(counter).toHaveText("1 / 17");
  await page.mouse.move(0, 0);
  await page.clock.runFor(6100);
  await expect(counter).toHaveText("2 / 17");
  await gallery.getByRole("button", { name: "Pause slideshow" }).click();
  await page.getByRole("heading", { name: "Gallery", exact: true }).click();
  await page.clock.runFor(12000);
  await expect(counter).toHaveText("2 / 17");
  await gallery.getByRole("button", { name: "Resume slideshow" }).click();
  await page.getByRole("heading", { name: "Gallery", exact: true }).click();
  await page.clock.runFor(6100);
  await expect(counter).toHaveText("3 / 17");
});

test("each homepage visit shuffles a complete sequence while the full gallery stays ordered", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  // Control randomness so different visits can be checked without flaky odds.
  await page.addInitScript(() => {
    let seed = window.location.search.includes("second") ? 67890 : 12345;
    Math.random = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 4294967296;
    };
  });
  const canonical = galleryPhotos.map((photo) => galleryImage(photo.id));
  const sequences: string[][] = [];
  for (const visit of ["first", "second"]) {
    await page.goto(`/en-us?visit=${visit}`);
    // The map is loaded by a client effect, after the gallery's mount effect.
    await expect(page.locator(".map-card")).toBeVisible();
    const gallery = page.locator("#gallery");
    const photo = gallery.getByRole("img");
    const sequence: string[] = [];
    for (let i = 0; i < canonical.length; i++) {
      sequence.push((await photo.getAttribute("src"))!);
      await gallery.getByRole("button", { name: "Next photo" }).focus();
      await page.keyboard.press("Enter");
      await expect(gallery.locator(".gallery-counter")).toHaveText(
        `${((i + 1) % canonical.length) + 1} / ${canonical.length}`,
      );
    }
    expect([...sequence].sort()).toEqual([...canonical].sort());
    await expect(photo).toHaveAttribute("src", sequence[0]);
    await gallery.getByRole("button", { name: "Previous photo" }).focus();
    await page.keyboard.press("Enter");
    await expect(photo).toHaveAttribute("src", sequence.at(-1)!);
    sequences.push(sequence);
  }
  expect(sequences[0][0]).not.toBe(sequences[1][0]);
  expect(sequences[0]).not.toEqual(sequences[1]);
  await page.locator(".gallery-photo-link").click();
  await expect(page).toHaveURL("/en-us/gallery", { timeout: 15000 });
  await expect(page.locator(".gallery-grid img")).toHaveCount(canonical.length);
  expect(
    await page
      .locator(".gallery-grid img")
      .evaluateAll((images) =>
        images.map((image) => image.getAttribute("src")),
      ),
  ).toEqual(canonical);
});

test("reduced motion keeps the slide still and keyboard controls work", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.clock.install();
  await page.goto("/en-us");
  const gallery = page.locator("#gallery");
  await expect(gallery.locator(".gallery-counter")).toHaveText("1 / 17");
  await page.clock.runFor(18000);
  await expect(gallery.locator(".gallery-counter")).toHaveText("1 / 17");
  await expect(
    gallery.getByRole("button", { name: "Pause slideshow" }),
  ).toHaveCount(0);
  await gallery.getByRole("button", { name: "Next photo" }).focus();
  await page.keyboard.press("Enter");
  await expect(gallery.locator(".gallery-counter")).toHaveText("2 / 17");
});

for (const locale of ["en-us", "zh-cn", "zh-hk"] as const) {
  test(`${locale}: photo opens the localized full collection and returns home`, async ({
    page,
  }, testInfo) => {
    const m = catalogs[locale];
    await page.goto(`/${locale}`);
    const gallery = page.locator("#gallery");
    await expect(
      gallery.getByRole("heading", { name: m.galleryTitle }),
    ).toBeVisible();
    await expect(
      gallery.getByRole("link", { name: m.galleryViewAll, exact: true }),
    ).toHaveAttribute("href", `/${locale}/gallery`);
    if (locale === "en-us") {
      await gallery.scrollIntoViewIfNeeded();
      await gallery
        .getByRole("img")
        .evaluate((image: HTMLImageElement) => image.decode());
      await gallery.screenshot({
        path: testInfo.outputPath("home-desktop.png"),
      });
    }
    await gallery.locator(".gallery-photo-link").click();
    // The first development request compiles this route on demand.
    await expect(page).toHaveURL(`/${locale}/gallery`, { timeout: 15000 });
    await expect(page).toHaveTitle(`${m.galleryTitle} · CKOCC Metro`);
    await expect(page.locator(".gallery-grid figure")).toHaveCount(17);
    const images = page.locator(".gallery-grid img");
    for (const image of await images.all()) {
      await image.scrollIntoViewIfNeeded();
      await expect(image).toBeVisible();
      await expect
        .poll(() =>
          image.evaluate(
            (element: HTMLImageElement) =>
              element.complete && element.naturalWidth > 0,
          ),
        )
        .toBe(true);
    }
    if (locale === "en-us") {
      await page.locator(".page-intro").scrollIntoViewIfNeeded();
      await page.screenshot({
        path: testInfo.outputPath("gallery-desktop.png"),
      });
    }
    await page.locator(".back-link").click();
    await expect(page).toHaveURL(`/${locale}#gallery`);
    await expect(page.locator("#gallery")).toBeInViewport();
  });
}

test("mobile gallery fits the viewport and all photos remain accessible", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/en-us");
  const gallery = page.locator("#gallery");
  await gallery.scrollIntoViewIfNeeded();
  await gallery.getByRole("button", { name: "Next photo" }).click();
  await expect(gallery.locator(".gallery-counter")).toHaveText("2 / 17");
  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    )
    .toBe(true);
  await gallery
    .getByRole("img")
    .evaluate((image: HTMLImageElement) => image.decode());
  await gallery.screenshot({ path: testInfo.outputPath("home-mobile.png") });
  await gallery.locator(".gallery-photo-link").click();
  await expect(page.locator(".gallery-grid figure")).toHaveCount(17);
  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    )
    .toBe(true);
  const first = await page.locator(".gallery-item").nth(0).boundingBox();
  const second = await page.locator(".gallery-item").nth(1).boundingBox();
  expect(second!.y).toBeGreaterThan(first!.y + first!.height);
  await page
    .locator(".gallery-item img")
    .first()
    .evaluate((image: HTMLImageElement) => image.decode());
  await page.locator(".page-intro").scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath("gallery-mobile.png") });
});
