import { expect, test, type Page } from "playwright/test";
import { getDictionary, type Locale } from "../../src/lib/i18n";

const revision = `sha256:${"a".repeat(64)}`;
const session = {
  id: "11111111-1111-4111-8111-111111111111",
  baseCommit: "1".repeat(40),
  baseMapRevision: revision,
  status: "draft",
  sourceUrl: "/api/edit-sessions/source",
  assets: {
    json: { pathname: "staging/map.json", bytes: 100 },
    png: { pathname: "staging/map.png", bytes: 100 },
  },
};

async function setup(page: Page, draft = false) {
  let signedInAgain = false;
  const writes: string[] = [];
  if (draft)
    await page.addInitScript((session) => {
      const key = "metro:update-admin-v1";
      if (!sessionStorage.getItem(key))
        sessionStorage.setItem(
          key,
          JSON.stringify({
            session,
            summary: "New map update",
            details: "Map details",
            issueNumbers: [],
            jsonName: "map.json",
            pngName: "map.png",
            idempotencyKey: null,
            submittedOperation: null,
          }),
        );
    }, session);
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/auth/session") {
      if (signedInAgain)
        await new Promise((resolve) => setTimeout(resolve, 150));
      return route.fulfill({
        json: {
          user: {
            id: "admin",
            name: "Admin",
            email: "admin@example.invalid",
            role: "admin",
          },
        },
      });
    }
    if (path === "/api/auth/sign-in/email") {
      signedInAgain = true;
      return route.fulfill({ json: { ok: true } });
    }
    if (path === "/api/notifications")
      return route.fulfill({ json: { notifications: [], unreadCount: 0 } });
    if (path === "/api/map/head")
      return route.fulfill({
        json: { revision, commitSha: session.baseCommit },
      });
    if (path === "/api/issues")
      return route.fulfill({ json: { issues: [], hasMore: false } });
    if (path.startsWith("/api/edit-sessions/"))
      return route.fulfill({ json: { editSession: session } });
    if (request.method() === "POST") {
      writes.push(path);
      return route.fulfill({
        status: 401,
        json: { error: { code: "fresh_auth_required" } },
      });
    }
    if (path === "/api/updates") {
      if (signedInAgain)
        await new Promise((resolve) => setTimeout(resolve, 250));
      const update = {
        status: "awaiting_review",
        prNumber: 42,
        prUrl: "https://github.com/test/map/pull/42",
        createdAt: "2026-10-22T10:00:00Z",
        baseMapRevision: revision,
        mapRevision: revision,
      };
      return route.fulfill({
        json: {
          updates: Array.from({ length: 10 }, (_, i) => ({
            ...update,
            id: `mine-${i}`,
            summary: `My update ${i}`,
          })),
          otherUpdates: Array.from({ length: 10 }, (_, i) => ({
            ...update,
            id: `other-${i}`,
            summary: `Other update ${i}`,
            authorName: "Builder",
          })),
        },
      });
    }
    if (path.startsWith("/api/admin/updates/"))
      return route.fulfill({
        json: {
          review: {
            prNumber: 42,
            prUrl: "https://github.com/test/map/pull/42",
            baseCommit: session.baseCommit,
            headSha: "2".repeat(40),
            mapRevision: revision,
            validation: {
              state: "success",
              checkedAt: "2026-10-22T10:00:00Z",
              runs: [],
            },
            canMerge: true,
            blockedReason: null,
          },
        },
      });
    return route.fulfill({
      status: 503,
      json: { error: { code: "TEST_UNAVAILABLE" } },
    });
  });
  return writes;
}

async function signIn(page: Page, locale: Locale) {
  const m = getDictionary(locale);
  const form = page.locator(".auth-form");
  await form
    .getByRole("textbox", { name: m.email, exact: true })
    .fill("admin@example.invalid");
  await form.getByLabel(m.password, { exact: true }).fill("test-password");
  await form.getByRole("button", { name: m.signIn, exact: true }).click();
}

for (const locale of ["en-us", "zh-cn", "zh-hk"] as const) {
  for (const action of [
    "create",
    "merge-mine",
    "merge-other",
    "close-mine",
    "close-other",
  ] as const) {
    test(`${locale} ${action} reauthentication returns to its update section`, async ({
      page,
    }) => {
      const m = getDictionary(locale);
      const writes = await setup(page, action === "create");
      if (locale === "zh-hk")
        await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(`/${locale}/updates`);
      const other = action.endsWith("other");
      if (action === "create") {
        await page
          .getByRole("button", { name: m.createPr, exact: true })
          .click();
      } else {
        const item = page
          .locator(other ? "#other-updates" : "#my-updates")
          .locator("details")
          .first();
        await item.locator("summary").click();
        if (action.startsWith("merge")) {
          await item
            .getByRole("button", { name: m.mergePr, exact: true })
            .click();
          await item
            .getByRole("button", { name: m.confirmMerge, exact: true })
            .click();
        } else {
          page.once("dialog", (dialog) => dialog.accept());
          await item
            .getByRole("button", { name: m.closeWithoutMerge, exact: true })
            .click();
        }
      }
      const section = other ? "other-updates" : "my-updates";
      const link = page.getByRole("link", { name: m.signInAgain });
      await expect(link).toHaveAttribute(
        "href",
        `/${locale}/login?next=${section}`,
      );
      await link.click();
      await signIn(page, locale);
      await expect(page).toHaveURL(`/${locale}/updates#${section}`);
      const heading = page
        .locator(`#${section}`)
        .getByRole("heading", { level: 2 });
      await expect(heading).toBeInViewport();
      await expect
        .poll(async () => (await heading.boundingBox())?.y ?? -1)
        .toBeGreaterThanOrEqual(100);
      expect(writes).toHaveLength(1); // Signing in must not replay the rejected action.
      if (action === "create")
        await expect(
          page.getByRole("textbox", { name: m.summary }),
        ).toHaveValue("New map update");
      if (action === "merge-other")
        await page.screenshot({ path: `/tmp/ckocc-reauth-${locale}.png` });
    });
  }
}

for (const scenario of [
  { query: "", destination: "/updates" },
  { query: "?next=admin", destination: "/admin" },
  { query: "?next=settings", destination: "/settings" },
  { query: "?next=notifications", destination: "" },
  { query: "?next=https%3A%2F%2Fexample.com", destination: "/updates" },
  {
    query: "?next=%2Fzh-cn%2Fupdates%3Ffrom%3Dinbox",
    destination: "/updates?from=inbox",
  },
]) {
  test(`existing login destination is preserved: ${scenario.query || "default"}`, async ({
    page,
  }) => {
    await setup(page);
    await page.goto(`/en-us/login${scenario.query}`);
    await signIn(page, "en-us");
    await expect(page).toHaveURL(`/en-us${scenario.destination}`);
    if (scenario.query === "?next=notifications")
      await expect(
        page.getByRole("heading", { name: "Notifications", exact: true }),
      ).toBeVisible();
  });
}

test("reauthentication prompts outside Updates still return to Admin", async ({
  page,
}) => {
  await setup(page);
  await page.route("**/api/admin/settings", (route) =>
    route.fulfill({
      status: 401,
      json: { error: { code: "fresh_auth_required" } },
    }),
  );
  await page.goto("/en-us/admin");
  const link = page.getByRole("link", {
    name: getDictionary("en-us").signInAgain,
  });
  await expect(link).toHaveAttribute("href", "/en-us/login?next=admin");
  await link.click();
  await signIn(page, "en-us");
  await expect(page).toHaveURL("/en-us/admin");
});
