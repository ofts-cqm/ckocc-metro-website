import { expect, test, type Page } from "playwright/test";
const revision = `sha256:${"a".repeat(64)}`;
const restored = `sha256:${"b".repeat(64)}`;
const baseCommit = "1".repeat(40),
  headSha = "2".repeat(40);
async function setup(
  page: Page,
  role = "admin",
  blocked: string | null = null,
  control = { state: "success", unavailable: false, reviews: 0 },
) {
  const writes: { path: string; body: unknown; key: string | undefined }[] = [];
  let didMerge = false;
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (path === "/api/auth/session")
      return route.fulfill({
        json: {
          user: {
            id: "admin",
            name: "Admin",
            email: "test@example.invalid",
            role,
          },
        },
      });
    if (path === "/api/map/head")
      return route.fulfill({ json: { revision, commitSha: baseCommit } });
    if (path === "/api/updates")
      return route.fulfill({
        json: {
          hasMore:
            !url.searchParams.has("page") ||
            url.searchParams.get("page") === "1",
          othersHasMore: url.searchParams.get("othersPage") !== "2",
          otherUpdates:
            role === "admin"
              ? [
                  {
                    id: "other",
                    prNumber: 44,
                    prUrl: "https://github.com/test/map/pull/44",
                    summary:
                      url.searchParams.get("othersPage") === "2"
                        ? "Older teammate update"
                        : "Teammate update",
                    authorName: "Map builder",
                    status: "awaiting_review",
                    createdAt: "2026-10-10T12:00:00Z",
                    baseMapRevision: restored,
                    mapRevision: revision,
                  },
                ]
              : [],
          updates: [
            {
              id: "pending",
              prNumber: 42,
              prUrl: "https://github.com/test/map/pull/42",
              summary:
                Number(url.searchParams.get("page") || 1) > 1
                  ? "Older update"
                  : "Proposed update",
              status: didMerge ? "published" : "awaiting_review",
              createdAt: "2026-10-10T12:00:00Z",
              baseMapRevision: restored,
              mapRevision: revision,
              isCurrentPublication: didMerge,
            },
            {
              id: "historical",
              prNumber: 41,
              prUrl: "https://github.com/test/map/pull/41",
              summary: "Historical update",
              status: "published",
              createdAt: "2026-10-09T12:00:00Z",
              baseMapRevision: restored,
              mapRevision: revision,
            },
          ],
        },
      });
    if (
      path.startsWith("/api/admin/updates/") &&
      route.request().method() === "GET"
    ) {
      control.reviews++;
      if (control.unavailable)
        return route.fulfill({
          status: 503,
          json: {
            error: { code: "provider_unavailable", message: "Unavailable" },
          },
        });
      return route.fulfill({
        json: {
          review: {
            validation: {
              state:
                blocked === "map_checks_pending" ? "pending" : control.state,
              checkedAt: "2026-10-10T12:00:00Z",
              runs: [],
            },
            headSha,
            baseCommit,
            currentRevision: revision,
            mapRevision: revision,
            restoreRevision: restored,
            prNumber: path.endsWith("historical") ? 41 : 42,
            prUrl: "https://github.com/test/map/pull/42",
            merged: path.endsWith("historical"),
            canMerge:
              !blocked &&
              control.state === "success" &&
              !path.endsWith("historical"),
            canRollback: path.endsWith("historical"),
            blockedReason: blocked,
          },
        },
      });
    }
    if (
      path.startsWith("/api/admin/updates/") &&
      route.request().method() === "POST"
    ) {
      writes.push({
        path,
        body: route.request().postDataJSON(),
        key: route.request().headers()["idempotency-key"],
      });
      didMerge = path.endsWith("merge");
      return route.fulfill({
        status: 202,
        json: {
          operation: {
            id: didMerge ? "merge-operation" : "rollback-operation",
          },
        },
      });
    }
    if (path.startsWith("/api/operations/"))
      return route.fulfill({
        json: {
          operation: {
            id: "operation",
            status: didMerge ? "succeeded" : "awaiting_review",
            kind: didMerge ? "merge" : "rollback",
            result: { prUrl: "https://github.com/test/map/pull/43" },
          },
        },
      });
    throw new Error(`Unexpected request ${path}`);
  });
  return writes;
}
async function expandUpdate(page: Page, title: string) {
  await page
    .locator(".update-accordion")
    .filter({ has: page.getByRole("heading", { name: title, exact: true }) })
    .locator("summary")
    .click();
}
const languages = [
  {
    locale: "en-us",
    merge: "Merge PR",
    confirm: "Confirm merge",
    rollback: "Create rollback PR",
    confirmRollback: "Confirm rollback PR",
    warning: /removes all later map changes/,
    cancel: "Cancel",
  },
  {
    locale: "zh-cn",
    merge: "合并 PR",
    confirm: "确认合并",
    rollback: "创建回滚 PR",
    confirmRollback: "确认创建回滚 PR",
    warning: /移除之后的所有地图更改/,
    cancel: "取消",
  },
  {
    locale: "zh-hk",
    merge: "合併 PR",
    confirm: "確認合併",
    rollback: "建立回滾 PR",
    confirmRollback: "確認建立回滾 PR",
    warning: /移除之後的所有地圖變更/,
    cancel: "取消",
  },
];
for (const language of languages)
  test(`administrator merge and historical rollback confirmation: ${language.locale}`, async ({
    page,
  }) => {
    const writes = await setup(page);
    await page.goto(`/${language.locale}/updates`);
    await expandUpdate(page, "Proposed update");
    await page
      .getByRole("region", {
        name: language.locale === "en-us" ? "My updates" : "我的更新",
      })
      .getByRole("button", { name: language.merge, exact: true })
      .click();
    const review = page.locator(".map-action-review");
    await expect(review.getByText(revision, { exact: true })).toBeVisible();
    expect(writes).toHaveLength(0);
    await page
      .getByRole("button", { name: language.confirm, exact: true })
      .click();
    await expect.poll(() => writes.length).toBe(1);
    expect(writes[0].body).toEqual({ baseCommit, headSha });
    expect(writes[0].key).toMatch(/^[a-f0-9-]{36}$/);
    const historical = page.locator(".history-item").filter({
      has: page.getByRole("heading", { name: "Historical update" }),
    });
    await historical.locator("summary").click();
    await historical
      .getByRole("button", { name: language.rollback, exact: true })
      .click();
    await expect(historical.getByText(language.warning)).toBeVisible();
    await expect(
      historical
        .locator(".map-action-review")
        .getByText(restored, { exact: true }),
    ).toBeVisible();
    await historical
      .getByRole("button", { name: language.cancel, exact: true })
      .click();
    expect(writes).toHaveLength(1);
    await historical
      .getByRole("button", { name: language.rollback, exact: true })
      .click();
    if (language.locale === "en-us")
      await page.screenshot({
        path: "/tmp/metro-map-actions-desktop.png",
        fullPage: true,
      });
    await page.setViewportSize({ width: 375, height: 812 });
    const prLink = await historical
      .getByRole("link", { name: "#41" })
      .boundingBox();
    expect(prLink).not.toBeNull();
    expect(prLink!.x + prLink!.width).toBeLessThanOrEqual(375);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: `/tmp/metro-map-actions-${language.locale}.png`,
      fullPage: true,
    });
    await historical
      .getByRole("button", { name: language.confirmRollback, exact: true })
      .click();
    await expect.poll(() => writes.length).toBe(2);
    expect(writes[1].body).toEqual({ baseCommit });
  });
test("collaborators cannot see administrator map controls", async ({
  page,
}) => {
  await setup(page, "collaborator");
  await page.goto("/en-us/updates");
  await expandUpdate(page, "Proposed update");
  await expect(
    page.getByRole("heading", { name: "Historical update" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Merge PR", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Create rollback PR", exact: true }),
  ).toHaveCount(0);
});
test("blocked merges show a reason and history supports older pages", async ({
  page,
}) => {
  const writes = await setup(page, "admin", "map_checks_pending");
  await page.goto("/en-us/updates");
  await expandUpdate(page, "Proposed update");
  await page
    .getByRole("region", { name: "My updates" })
    .getByRole("button", { name: "Merge PR", exact: true })
    .click();
  await expect(page.getByText(/validate-map check must finish/)).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Confirm merge", exact: true }),
  ).toHaveCount(0);
  expect(writes).toHaveLength(0);
  await page
    .getByRole("region", { name: "My updates" })
    .getByRole("button", { name: "Next", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Older update" }),
  ).toBeVisible();
  await page
    .getByRole("region", { name: "My updates" })
    .getByRole("button", { name: "Previous", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Proposed update" }),
  ).toBeVisible();
});

test("check widget refreshes running, failed, unavailable and passing results without GitHub", async ({
  page,
}) => {
  await page.clock.install();
  const control = { state: "running", unavailable: false, reviews: 0 };
  const writes = await setup(page, "admin", null, control);
  await page.goto("/en-us/updates");
  await expandUpdate(page, "Proposed update");
  await page
    .getByRole("region", { name: "My updates" })
    .getByRole("button", { name: "Merge PR", exact: true })
    .click();
  const widget = page.locator(".map-check-widget");
  await expect(
    widget.getByText("Check in progress", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Confirm merge", exact: true }),
  ).toHaveCount(0);
  control.state = "failure";
  await widget.getByRole("button", { name: "Refresh checks" }).click();
  await expect(widget.getByText("Failed", { exact: true })).toBeVisible();
  control.state = "success";
  await widget.getByRole("button", { name: "Refresh checks" }).click();
  await expect(widget.getByText("Passed", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Confirm merge", exact: true }),
  ).toBeEnabled();
  control.unavailable = true;
  await widget.getByRole("button", { name: "Refresh checks" }).click();
  await expect(
    widget.getByText("Check status unavailable", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Confirm merge", exact: true }),
  ).toHaveCount(0);
  control.unavailable = false;
  await page.clock.fastForward(15000);
  await expect(widget.getByText("Passed", { exact: true })).toBeVisible();
  expect(writes).toHaveLength(0);
  await page.setViewportSize({ width: 375, height: 812 });
  await widget.scrollIntoViewIfNeeded();
  await expect(widget).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "/tmp/metro-check-widget-mobile.png",
    fullPage: true,
  });
});
test("administrator histories separate creators and paginate independently with controls in both", async ({
  page,
}) => {
  await setup(page);
  await page.goto("/en-us/updates");
  await expandUpdate(page, "Proposed update");
  const mine = page.getByRole("region", { name: "My updates" });
  const others = page.getByRole("region", { name: "Updates from others" });
  await expect(
    mine.getByRole("heading", { name: "Proposed update" }),
  ).toBeVisible();
  await expect(
    mine.getByRole("heading", { name: "Teammate update" }),
  ).toHaveCount(0);
  await expect(others.getByText("Submitted by: Map builder")).toBeVisible();
  await expandUpdate(page, "Teammate update");
  await expect(
    others.getByRole("button", { name: "Merge PR", exact: true }),
  ).toBeVisible();
  await others.getByRole("button", { name: "Next", exact: true }).click();
  await expect(
    others.getByRole("heading", { name: "Older teammate update" }),
  ).toBeVisible();
  await expect(
    mine.getByRole("heading", { name: "Proposed update" }),
  ).toBeVisible();
  await expandUpdate(page, "Older teammate update");
  await others.getByRole("button", { name: "Merge PR", exact: true }).click();
  await expect(
    others.locator(".map-check-widget").getByText("Passed", { exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: "/tmp/metro-updates-separated.png",
    fullPage: true,
  });
});

test("updates start compact, support keyboard expansion, and stop check polling when collapsed", async ({
  page,
}) => {
  await page.clock.install();
  const control = { state: "success", unavailable: false, reviews: 0 };
  await setup(page, "admin", null, control);
  await page.goto("/en-us/updates");
  const mine = page.getByRole("region", { name: "My updates" });
  const item = mine.locator(".update-accordion").first();
  await expect(item).not.toHaveAttribute("open", "");
  await expect(
    item.getByRole("button", { name: "Merge PR", exact: true }),
  ).toBeHidden();
  await expect(mine.getByText("Page 1 · 10 per page")).toBeVisible();
  await item.locator("summary").focus();
  await page.keyboard.press("Enter");
  await expect(item).toHaveAttribute("open", "");
  await item.getByRole("button", { name: "Merge PR", exact: true }).click();
  await expect(item.locator(".map-check-widget")).toBeVisible();
  const requests = control.reviews;
  await item.locator("summary").click();
  await expect(item.locator(".map-check-widget")).toBeHidden();
  await page.clock.fastForward(30000);
  expect(control.reviews).toBe(requests);
  await page.setViewportSize({ width: 375, height: 812 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "/tmp/metro-updates-collapsed-mobile.png",
    fullPage: true,
  });
  await item.locator("summary").click();
  await expect(item.locator(".map-check-widget")).toBeVisible();
  await page.clock.fastForward(15000);
  await expect.poll(() => control.reviews).toBeGreaterThan(requests);
});
