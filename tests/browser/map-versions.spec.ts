import { expect, test } from "playwright/test";

const current = `sha256:${"a".repeat(64)}`;
const submitted = `sha256:${"b".repeat(64)}`;
const base = `sha256:${"c".repeat(64)}`;

test("map versions are complete, copyable and validate without GitHub", async ({
  page,
}) => {
  const submissions: Record<string, unknown>[] = [];
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/auth/session") {
      await route.fulfill({
        json: {
          user: {
            id: "version-player",
            email: "player@example.invalid",
            name: "Player",
            role: "collaborator",
          },
        },
      });
    } else if (path === "/api/map/head") {
      await route.fulfill({
        json: { revision: current, commitSha: "1".repeat(40) },
      });
    } else if (path === "/api/updates") {
      await route.fulfill({
        json: {
          updates: [
            {
              id: "update",
              summary: "Previous update",
              status: "published",
              createdAt: "2026-10-06T12:00:00Z",
              updatedAt: "2026-10-06T12:00:00Z",
              baseMapRevision: base,
              mapRevision: submitted,
            },
          ],
        },
      });
    } else if (path === "/api/edit-sessions") {
      submissions.push(route.request().postDataJSON());
      await route.fulfill({
        status: 404,
        json: { error: { code: "base_revision_not_found" } },
      });
    } else {
      throw new Error(`Unexpected request: ${path}`);
    }
  });
  await page.goto("/en-us/updates");
  await expect(page.getByText(current, { exact: true })).toBeVisible();
  await expect(page.getByText(submitted, { exact: true })).toBeVisible();
  await expect(page.getByText(base, { exact: true })).toBeVisible();
  await page.getByText("Already editing a downloaded map?").click();
  const input = page.getByLabel(/^Starting map SHA-256/);
  await input.fill("bad-hash");
  await expect(page.getByText(/^Invalid format\./)).toBeVisible();
  const start = page.getByRole("button", { name: "Start a map update" });
  await expect(start).toBeDisabled();
  await input.fill(current);
  await expect(start).toBeEnabled();
  await start.click();
  await expect(
    page.getByText(/This version was not found in approved map history/),
  ).toBeVisible();
  expect(submissions).toEqual([{ baseCommit: current }]);
  await input.fill("a".repeat(64));
  await expect(page.getByText(/This version was not found/)).toHaveCount(0);
  await expect(start).toBeEnabled();
  await page.screenshot({
    path: "/tmp/map-versions-desktop.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 375, height: 812 });
  await expect(page.getByText(current, { exact: true })).toBeVisible();
  await expect(page.getByText(submitted, { exact: true })).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "/tmp/map-versions-mobile.png",
    fullPage: true,
  });
});
