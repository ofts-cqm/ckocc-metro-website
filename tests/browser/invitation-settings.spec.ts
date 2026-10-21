import { expect, test } from "playwright/test";
import { getDictionary } from "../../src/lib/i18n";

for (const scenario of [
  { locale: "en-us", kind: "invite", page: "invite" },
  { locale: "zh-hk", kind: "invite", page: "invite" },
  // Reset links are also issued through /invite, with their kind from the API.
  { locale: "en-us", kind: "reset", page: "invite" },
  { locale: "en-us", kind: "reset", page: "reset" },
] as const) {
  test(`${scenario.locale} ${scenario.kind} on /${scenario.page} signs in to the expected page`, async ({
    page,
  }) => {
    const m = getDictionary(scenario.locale);
    let signedIn = false;
    let redeemed = false;
    const email = "new-player@example.invalid";
    const password = "test-invitation-password";
    await page.route("**/api/**", async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (path === "/api/auth/session")
        return route.fulfill({
          json: {
            user: signedIn
              ? {
                  id: "new-player",
                  name: "Player",
                  email,
                  role: "collaborator",
                }
              : null,
          },
        });
      if (path === "/api/invitations")
        return route.fulfill({
          json: {
            invitation: {
              email,
              displayName: "Player",
              kind: scenario.kind,
              expiresAt: "2099-01-01T00:00:00Z",
            },
          },
        });
      if (path === "/api/invitations/redeem") {
        expect(request.postDataJSON()).toEqual({
          token: "test-token",
          password,
        });
        redeemed = true;
        return route.fulfill({ json: { ok: true } });
      }
      if (path === "/api/auth/sign-in/email") {
        expect(redeemed).toBe(true);
        expect(request.postDataJSON()).toEqual({ email, password });
        signedIn = true;
        return route.fulfill({ json: { ok: true } });
      }
      if (path === "/api/notifications")
        return route.fulfill({ json: { notifications: [], unreadCount: 0 } });
      if (path === "/api/email/preferences") {
        expect(request.method()).toBe("GET");
        return route.fulfill({
          json: {
            preferences: {
              email,
              verified: false,
              enabled: false,
              locale: scenario.locale,
              pendingAddress: null,
              suppressed: false,
            },
          },
        });
      }
      return route.fulfill({
        status: 503,
        json: { error: { code: "TEST_UNAVAILABLE", message: "Test fixture" } },
      });
    });

    await page.goto(`/${scenario.locale}/${scenario.page}?token=test-token`);
    await page.getByLabel(m.newPassword).fill(password);
    await page.getByLabel(m.confirmPassword, { exact: true }).fill(password);
    await page
      .getByRole("button", {
        name: scenario.kind === "invite" ? m.activate : m.resetPassword,
        exact: true,
      })
      .click();
    await expect(
      page.getByRole("heading", { name: m.accountReady }),
    ).toBeVisible();
    await expect(page).toHaveURL(`/${scenario.locale}/${scenario.page}`);
    const signIn = page
      .locator(".success-panel")
      .getByRole("link", { name: m.signIn });
    await expect(signIn).toHaveAttribute(
      "href",
      `/${scenario.locale}/login${scenario.kind === "invite" ? "?next=settings" : ""}`,
    );
    await signIn.click();
    await page.getByRole("textbox", { name: m.email, exact: true }).fill(email);
    await page.getByLabel(m.password, { exact: true }).fill(password);
    await page.getByRole("button", { name: m.signIn, exact: true }).click();
    await expect(page).toHaveURL(
      `/${scenario.locale}/${scenario.kind === "invite" ? "settings" : "updates"}`,
    );
    if (scenario.kind === "invite") {
      await expect(
        page.getByRole("heading", { name: m.emailSettings }),
      ).toBeVisible();
      await expect(
        page.getByRole("checkbox", { name: m.emailOptIn }),
      ).not.toBeChecked();
    }
  });
}
