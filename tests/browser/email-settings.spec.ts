import { expect, test, type Page } from "playwright/test";

async function fixture(page: Page) {
  const preferences = {
    email: "player@example.invalid",
    verified: false,
    enabled: false,
    locale: "en-us",
    pendingAddress: null as string | null,
    suppressed: false,
  };
  const requests: { path: string; body: Record<string, unknown> }[] = [];
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/auth/session")
      return route.fulfill({
        json: {
          user: {
            id: "player",
            name: "Player",
            email: preferences.email,
            role: "collaborator",
          },
        },
      });
    if (path === "/api/notifications")
      return route.fulfill({ json: { notifications: [], unreadCount: 0 } });
    if (request.method() === "POST")
      requests.push({ path, body: request.postDataJSON() });
    if (path === "/api/email/preferences") {
      if (request.method() === "POST")
        Object.assign(preferences, request.postDataJSON());
      return route.fulfill({ json: { preferences } });
    }
    if (path === "/api/email/verification") {
      preferences.pendingAddress = request.postDataJSON().address ?? null;
      return route.fulfill({ status: 202, json: { queued: true } });
    }
    if (path === "/api/email/verify" || path === "/api/email/unsubscribe")
      return route.fulfill({ json: { changed: path.endsWith("verify") } });
    throw new Error(`Unexpected request ${path}`);
  });
  return { preferences, requests };
}

test("settings show opt-in, verification and pending replacement while preserving current address", async ({
  page,
}) => {
  const { requests } = await fixture(page);
  await page.goto("/en-us/settings");
  await expect(
    page.getByRole("heading", { name: "Email settings" }),
  ).toBeVisible();
  const optIn = page.getByRole("checkbox", {
    name: "Send me discussion notification emails",
  });
  await expect(optIn).not.toBeChecked();
  await optIn.check();
  await expect(page.getByText("Email preferences saved.")).toBeVisible();
  expect(requests[0].body).toEqual({ enabled: true, locale: "en-us" });
  await page.getByRole("button", { name: "Send verification email" }).click();
  await expect(page.getByText(/Verification email queued/)).toBeVisible();
  await page
    .getByRole("textbox", { name: "New email address" })
    .fill("replacement@example.invalid");
  await page
    .getByLabel("Password", { exact: true })
    .fill("a-current-test-password");
  await page.getByRole("button", { name: "Change email address" }).click();
  await expect(
    page.getByText(/Verification pending for replacement/),
  ).toBeVisible();
  await expect(
    page.getByText("player@example.invalid", { exact: false }),
  ).toBeVisible();
  expect(requests.at(-1)?.body).toEqual({
    locale: "en-us",
    address: "replacement@example.invalid",
    password: "a-current-test-password",
  });
  await expect(page.getByLabel("Password", { exact: true })).toBeEmpty();
});

for (const mode of ["verify", "unsubscribe"] as const)
  test(`${mode} requires deliberate POST and removes token after confirmation`, async ({
    page,
  }) => {
    const { requests } = await fixture(page);
    await page.goto(`/en-us/email/${mode}#token=test-token`);
    const title =
      mode === "verify"
        ? "Confirm email address"
        : "Disable email notifications";
    await expect(page.getByRole("heading", { name: title })).toBeVisible();
    expect(requests).toHaveLength(0);
    await page.getByRole("button", { name: title }).click();
    await expect(page).toHaveURL(new RegExp(`/en-us/email/${mode}$`));
    expect(requests).toEqual([
      { path: `/api/email/${mode}`, body: { token: "test-token" } },
    ]);
    await expect(
      page.getByText(
        mode === "verify"
          ? "Email address changed. Sign in with your new address."
          : "Email notifications disabled.",
      ),
    ).toBeVisible();
  });

test("settings controls are localized and suppression stays visible", async ({
  page,
}) => {
  const { preferences } = await fixture(page);
  preferences.suppressed = true;
  await page.goto("/zh-hk/settings");
  await expect(page.getByRole("heading", { name: "郵件設定" })).toBeVisible();
  await expect(page.getByText(/此電郵因退信或投訴已暫停投遞/)).toBeVisible();
});
