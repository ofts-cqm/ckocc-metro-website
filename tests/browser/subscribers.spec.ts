import { expect, test, type Page } from "playwright/test";
import { subscriberMessages } from "../../src/lib/subscriber-messages";
import { getDictionary } from "../../src/lib/i18n";

async function fixture(
  page: Page,
  role: "subscriber" | "collaborator" | null = null,
) {
  const state = {
    role,
    writes: [] as Record<string, unknown>[],
    inboxRequests: 0,
  };
  await page.route("https://challenges.cloudflare.com/**", (route) =>
    route.fulfill({
      contentType: "application/javascript",
      body: 'window.turnstile={render:(_e,o)=>{o.callback("challenge");return "widget"},remove:()=>{}}',
    }),
  );
  await page.route("**/api/**", async (route) => {
    const req = route.request(),
      path = new URL(req.url()).pathname;
    if (path === "/api/auth/session")
      return route.fulfill({
        json: {
          user: state.role
            ? {
                id: "subscriber",
                name: "MapReader",
                email: "reader@example.invalid",
                role: state.role,
              }
            : null,
        },
      });
    if (path === "/api/map") return route.fulfill({ json: { map: null } });
    if (path === "/api/issues")
      return route.fulfill({ json: { issues: [], page: 1, hasMore: false } });
    if (path === "/api/subscriptions") {
      state.writes.push(req.postDataJSON());
      return route.fulfill({
        status: 200,
        json: { ok: true, delivery: "sent" },
      });
    }
    if (path === "/api/notifications") {
      state.inboxRequests++;
      return route.fulfill({ json: { notifications: [], unreadCount: 0 } });
    }
    if (path === "/api/invitations")
      return route.fulfill({
        json: {
          invitation: {
            kind: "subscribe",
            email: "reader@example.invalid",
            displayName: "MapReader",
            expiresAt: "2099-01-01",
          },
        },
      });
    if (path === "/api/invitations/redeem") {
      state.role = "subscriber";
      return route.fulfill({
        json: { ok: true, subscribed: true, signedIn: true },
      });
    }
    if (path === "/api/email/preferences") {
      if (req.method() === "POST") state.writes.push(req.postDataJSON());
      return route.fulfill({
        json: {
          preferences: {
            email: "reader@example.invalid",
            verified: true,
            enabled: false,
            mapUpdates: true,
            locale: "en-us",
            pendingAddress: null,
            suppressed: false,
          },
        },
      });
    }
    return route.fulfill({ json: {} });
  });
  return state;
}
for (const locale of ["en-us", "zh-cn", "zh-hk"] as const) {
  test(`${locale} subscription entry points appear under map and on login`, async ({
    page,
  }) => {
    await fixture(page);
    const sm = subscriberMessages(locale);
    await page.goto(`/${locale}`);
    const cta = page.getByRole("link", { name: sm.subscribe, exact: true });
    await expect(cta).toBeVisible();
    await expect(cta).toHaveAttribute("href", `/${locale}/subscribe`);
    await expect(
      page.locator(".below-map + .subscription-callout"),
    ).toBeVisible();
    await page.goto(`/${locale}/login`);
    await expect(
      page.getByRole("link", { name: sm.subscribe, exact: true }),
    ).toBeVisible();
  });
}
test("public subscription records explicit consent and submits guest challenge", async ({
  page,
}) => {
  const state = await fixture(page);
  const m = getDictionary("en-us");
  const sm = subscriberMessages("en-us");
  await page.goto("/en-us/subscribe");
  await page
    .getByLabel(m.email, { exact: true })
    .fill("reader@example.invalid");
  await page.getByLabel(m.gameName, { exact: false }).fill("MapReader");
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: sm.subscribe, exact: true }).click();
  await expect(page.getByText(sm.sent)).toBeVisible();
  expect(state.writes[0]).toMatchObject({
    email: "reader@example.invalid",
    displayName: "MapReader",
    locale: "en-US",
    challenge: "challenge",
  });
  expect(state.writes[0]).not.toHaveProperty("role");
});
test("subscriber activation enters settings and hides collaborator controls", async ({
  page,
}) => {
  const state = await fixture(page);
  const m = getDictionary("en-us");
  const sm = subscriberMessages("en-us");
  await page.goto("/en-us/invite?token=test-token");
  await page
    .getByLabel(m.newPassword, { exact: false })
    .fill("test-long-password");
  await page
    .getByLabel(m.confirmPassword, { exact: true })
    .fill("test-long-password");
  await page.getByRole("button", { name: sm.subscribe, exact: true }).click();
  await expect(page).toHaveURL(/\/en-us\/settings$/);
  await expect(
    page.getByRole("checkbox", { name: sm.mapEmails }),
  ).toBeChecked();
  await expect(page.getByRole("checkbox", { name: m.emailOptIn })).toHaveCount(
    0,
  );
  await expect(
    page.getByRole("button", { name: m.notifications, exact: true }),
  ).toHaveCount(0);
  await expect(
    page
      .locator(".desktop-nav")
      .getByRole("link", { name: m.updates, exact: true }),
  ).toHaveCount(0);
  expect(state.inboxRequests).toBe(0);
  await page.goto("/en-us/updates");
  await expect(page.getByText(m.forbiddenTitle, { exact: true })).toBeVisible();
});
test("collaborator map preference is independent of discussion emails", async ({
  page,
}) => {
  const state = await fixture(page, "collaborator");
  const sm = subscriberMessages("en-us");
  const m = getDictionary("en-us");
  await page.goto("/en-us/settings");
  await expect(
    page.getByRole("checkbox", { name: m.emailOptIn }),
  ).not.toBeChecked();
  await page.getByRole("checkbox", { name: sm.mapEmails }).uncheck();
  await expect.poll(() => state.writes.length).toBe(1);
  expect(state.writes[0]).toMatchObject({ enabled: false, mapUpdates: false });
});

test("unverified subscriber can request verification but cannot change preferences", async ({
  page,
}) => {
  await fixture(page, "subscriber");
  const sm = subscriberMessages("en-us"),
    m = getDictionary("en-us");
  let requests = 0;
  await page.route("**/api/email/preferences", (route) =>
    route.fulfill({
      json: {
        preferences: {
          email: "reader@example.invalid",
          verified: false,
          enabled: false,
          mapUpdates: true,
          locale: "en-us",
          pendingAddress: null,
          suppressed: false,
        },
      },
    }),
  );
  await page.route("**/api/email/verification", (route) => {
    requests++;
    return route.fulfill({ json: { ok: true } });
  });
  await page.goto("/en-us/settings");
  await expect(
    page.getByRole("checkbox", { name: sm.mapEmails }),
  ).toBeDisabled();
  await expect(
    page.getByLabel(m.emailNewAddress, { exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: m.emailSendVerification }).click();
  await expect.poll(() => requests).toBe(1);
});

test("administrator can cancel, resolve a name conflict, promote and demote", async ({
  page,
}) => {
  const sm = subscriberMessages("en-us"),
    m = getDictionary("en-us");
  let signedIn = true;
  const writes: Record<string, unknown>[] = [];
  const accounts = [
    {
      id: "admin",
      name: "Admin",
      email: "admin@example.invalid",
      role: "admin",
      active: true,
    },
    {
      id: "reader",
      name: "MapReader",
      email: "reader@example.invalid",
      role: "subscriber",
      active: true,
    },
  ];
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/role")) {
      const body = route.request().postDataJSON();
      writes.push(body);
      if (path.includes("/reader/") && !body.displayName)
        return route.fulfill({
          status: 409,
          json: { error: { code: "name_conflict", message: "name conflict" } },
        });
      const target = accounts.find((a) => a.id === path.split("/").at(-2))!;
      target.role = body.role;
      if (body.displayName) target.name = body.displayName;
      if (target.id === "admin") signedIn = false;
      return route.fulfill({ json: { ok: true } });
    }
    const responses: Record<string, unknown> = {
      "/api/auth/session": { user: signedIn ? accounts[0] : null },
      "/api/notifications": { notifications: [], unreadCount: 0 },
      "/api/admin/accounts": { accounts },
      "/api/admin/settings": { publicWritesPaused: false },
      "/api/admin/invitations": { invitations: [] },
      "/api/admin/email": { jobs: [], feedback: [] },
      "/api/admin/operations": { operations: [] },
    };
    return route.fulfill({ json: responses[path] ?? {} });
  });
  await page.goto("/en-us/admin");
  let card = page
    .locator(".account-card")
    .filter({ hasText: "reader@example.invalid" });
  await card.getByRole("combobox").selectOption("collaborator");
  page.once("dialog", (d) => d.dismiss());
  await card.getByRole("button", { name: sm.saveRole }).click();
  expect(writes).toHaveLength(0);
  page.once("dialog", (d) => d.accept());
  await card.getByRole("button", { name: sm.saveRole }).click();
  await expect(page.getByText(sm.nameConflict, { exact: true })).toBeVisible();
  await card.getByRole("textbox").fill("NewMapReader");
  await card.scrollIntoViewIfNeeded();
  await page.screenshot({ path: "/tmp/subscriber-admin-role-fixed.png" });
  expect(
    await card
      .locator(".account-info")
      .evaluate((el) => el.getBoundingClientRect().width),
  ).toBeGreaterThan(150);
  page.once("dialog", (d) => d.accept());
  await card.getByRole("button", { name: sm.saveRole }).click();
  await expect(card.getByRole("combobox")).toHaveValue("collaborator");
  expect(writes[1]).toEqual({
    role: "collaborator",
    displayName: "NewMapReader",
  });
  card = page
    .locator(".account-card")
    .filter({ hasText: "admin@example.invalid" });
  await card.getByRole("combobox").selectOption("subscriber");
  page.once("dialog", (d) => d.accept());
  await card.getByRole("button", { name: sm.saveRole }).click();
  await expect(page.getByText(m.signedOut, { exact: true })).toBeVisible();
  expect(writes[2]).toEqual({ role: "subscriber" });
});

for (const locale of ["en-us", "zh-cn", "zh-hk"] as const) {
  test(`${locale} registration shows explicit conflicts and delivery states without false success`, async ({
    page,
  }) => {
    await fixture(page);
    const m = getDictionary(locale),
      sm = subscriberMessages(locale);
    let reply: { status: number; json: unknown } = {
      status: 409,
      json: { error: { code: "subscription_email_taken" } },
    };
    await page.route("**/api/subscriptions", (route) => route.fulfill(reply));
    await page.goto(`/${locale}/subscribe`);
    await page
      .getByLabel(m.email, { exact: true })
      .fill("reader@example.invalid");
    await page.getByLabel(m.gameName, { exact: false }).fill("MapReader");
    await page.getByRole("checkbox").check();
    for (const [code, message] of [
      ["subscription_email_taken", sm.emailTaken],
      ["name_conflict", sm.nameTaken],
      ["subscription_invitation_pending", sm.invitationPending],
      ["subscription_delivery_pending", sm.deliveryPending],
      ["subscription_delivery_failed", sm.deliveryFailed],
      ["subscription_delivery_unknown", sm.deliveryUnknown],
    ]) {
      reply = { status: 409, json: { error: { code } } };
      await page
        .getByRole("button", { name: sm.subscribe, exact: true })
        .click();
      await expect(
        page.locator(".form-panel").getByRole("alert"),
      ).toContainText(message);
      await expect(page.getByText(sm.sent, { exact: true })).toHaveCount(0);
      await expect(page.getByLabel(m.email, { exact: true })).toHaveValue(
        "reader@example.invalid",
      );
    }
    // A stale generic success response is insufficient evidence of sending.
    reply = { status: 202, json: { ok: true } };
    await page.getByRole("button", { name: sm.subscribe, exact: true }).click();
    await expect(page.locator(".form-panel").getByRole("alert")).toContainText(
      sm.deliveryUnknown,
    );
    reply = { status: 200, json: { ok: true, delivery: "sent" } };
    await page.getByRole("button", { name: sm.subscribe, exact: true }).click();
    await expect(page.getByText(sm.sent, { exact: true })).toBeVisible();
  });
}

for (const locale of ["en-us", "zh-cn", "zh-hk"] as const) {
  test(`${locale} administrator confirms permanent deletion and sees safe blockers`, async ({
    page,
  }) => {
    const sm = subscriberMessages(locale);
    let busy = true;
    const writes: unknown[] = [];
    let accounts = [
      {
        id: "admin",
        name: "Admin",
        email: "admin@example.invalid",
        role: "admin",
        active: true,
      },
      {
        id: "reader",
        name: "MapReader",
        email: "reader@example.invalid",
        role: "subscriber",
        active: true,
      },
    ];
    await page.route("**/api/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === "/api/admin/accounts/reader/delete") {
        writes.push(route.request().postDataJSON());
        if (busy)
          return route.fulfill({
            status: 409,
            json: { error: { code: "account_delete_busy" } },
          });
        accounts = accounts.filter((account) => account.id !== "reader");
        return route.fulfill({ json: { ok: true } });
      }
      const data: Record<string, unknown> = {
        "/api/auth/session": { user: accounts[0] },
        "/api/notifications": { notifications: [], unreadCount: 0 },
        "/api/admin/accounts": { accounts },
        "/api/admin/settings": { publicWritesPaused: false },
        "/api/admin/invitations": { invitations: [] },
        "/api/admin/operations": { operations: [] },
        "/api/admin/email": { jobs: [], feedback: [] },
      };
      return route.fulfill({ json: data[path] ?? {} });
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/${locale}/admin`);
    const card = page
      .locator(".account-card")
      .filter({ hasText: "reader@example.invalid" });
    const deleteButton = card.getByRole("button", {
      name: sm.deleteAccount,
      exact: true,
    });
    await expect(
      page
        .locator(".account-card")
        .filter({ hasText: "admin@example.invalid" })
        .getByRole("button", { name: sm.deleteAccount, exact: true }),
    ).toBeDisabled();
    await deleteButton.scrollIntoViewIfNeeded();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    if (locale === "en-us")
      await page.screenshot({ path: "/tmp/account-delete-mobile.png" });
    page.once("dialog", (dialog) => dialog.dismiss());
    await deleteButton.click();
    expect(writes).toHaveLength(0);
    page.once("dialog", async (dialog) => {
      expect(dialog.message()).toContain("reader@example.invalid");
      await dialog.accept();
    });
    await deleteButton.click();
    await expect(page.locator(".notice-error")).toContainText(sm.deleteBusy);
    await expect(card).toBeVisible();
    busy = false;
    page.once("dialog", (dialog) => dialog.accept());
    await deleteButton.click();
    await expect(card).toHaveCount(0);
    await expect(
      page.getByText(sm.accountDeleted, { exact: true }),
    ).toBeVisible();
    expect(writes).toEqual([
      { confirmation: "reader" },
      { confirmation: "reader" },
    ]);
  });
}
