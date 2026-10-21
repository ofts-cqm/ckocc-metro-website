import { expect, test, type Page } from "playwright/test";

async function fixture(page: Page, signedIn: boolean) {
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/auth/session")
      return route.fulfill({
        json: {
          user: signedIn
            ? {
                id: "email-reader",
                name: "Reader",
                email: "reader@example.invalid",
                role: "collaborator",
              }
            : null,
        },
      });
    if (path === "/api/auth/sign-in/email") {
      signedIn = true;
      return route.fulfill({ json: { ok: true } });
    }
    if (path === "/api/notifications")
      return route.fulfill({ json: { notifications: [], unreadCount: 0 } });
    return route.fulfill({
      status: 503,
      json: {
        error: {
          code: "preview_unavailable",
          message: "Map unavailable in this test.",
        },
      },
    });
  });
}

test("daily-limit email link opens the signed-in website inbox", async ({
  page,
}) => {
  await fixture(page, true);
  await page.goto("/en-us?notifications=open");
  await expect(
    page.getByRole("heading", { name: "Notifications", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("No notifications yet.")).toBeVisible();
  await expect(page).toHaveURL(/\/en-us$/);
});

test("daily-limit email link returns to the inbox after signing in", async ({
  page,
}) => {
  await fixture(page, false);
  await page.goto("/en-us?notifications=open");
  await expect(page).toHaveURL(/\/en-us\/login\?next=notifications$/);
  await page
    .getByRole("textbox", { name: "Email address" })
    .fill("reader@example.invalid");
  await page.getByLabel("Password", { exact: true }).fill("preview-password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Notifications", exact: true }),
  ).toBeVisible();
});
