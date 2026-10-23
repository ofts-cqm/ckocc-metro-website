import { expect, test } from "playwright/test";
const revision = `sha256:${"a".repeat(64)}`;
const failed = {
  id: "failed",
  summary: "Failed update",
  status: "failed",
  canDelete: true,
  canRevise: true,
  baseMapRevision: revision,
  createdAt: "2026-10-22T10:00:00Z",
};
const pending = {
  ...failed,
  id: "pending",
  summary: "Other player's PR",
  authorName: "Other player",
  status: "awaiting_review",
  prNumber: 42,
  prUrl: "https://github.com/test/map/pull/42",
  canDelete: false,
  canRevise: false,
  canEdit: true,
};
for (const role of ["admin", "collaborator"] as const) {
  test(`${role} sees appropriate update controls and deletion handles cancellation and errors`, async ({
    page,
  }) => {
    let deleted = false,
      attempts = 0;
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.route("**/api/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === "/api/auth/session")
        return route.fulfill({
          json: {
            user: {
              id: "player",
              name: "Player",
              role,
              email: "p@example.invalid",
            },
          },
        });
      if (path === "/api/notifications")
        return route.fulfill({ json: { notifications: [], unreadCount: 0 } });
      if (path === "/api/map/head")
        return route.fulfill({ json: { revision, commitSha: "1".repeat(40) } });
      if (path === "/api/issues")
        return route.fulfill({ json: { issues: [], hasMore: false } });
      if (path === "/api/updates")
        return route.fulfill({
          json: {
            updates: deleted ? [] : [failed],
            otherUpdates: role === "admin" ? [pending] : [],
            pendingOthers: role === "collaborator" ? [pending] : [],
          },
        });
      if (path === "/api/updates/failed") {
        expect(route.request().method()).toBe("DELETE");
        attempts++;
        if (attempts === 1)
          return route.fulfill({
            status: 409,
            json: { error: { code: "update_has_active_pr" } },
          });
        deleted = true;
        return route.fulfill({ json: { deleted: true } });
      }
      throw new Error(`Unexpected ${path}`);
    });
    await page.goto("/en-us/updates");
    const item = page
      .locator(".update-accordion")
      .filter({ hasText: "Failed update" });
    await item.locator("summary").click();
    if (role === "admin") {
      const other = page
        .locator(".update-accordion")
        .filter({ hasText: pending.summary });
      await other.locator("summary").click();
      await expect(
        other.getByRole("button", { name: "Close without merge" }),
      ).toBeVisible();
      await expect(
        other.getByRole("button", { name: "Edit update", exact: true }),
      ).toBeVisible();
      await expect(
        other.getByRole("button", { name: "Delete update" }),
      ).toHaveCount(0);
      await page.screenshot({
        path: "/tmp/ckocc-update-management-admin.png",
        fullPage: true,
      });
      await page.setViewportSize({ width: 390, height: 844 });
      await other.scrollIntoViewIfNeeded();
      await expect(
        other.getByRole("button", { name: "Close without merge" }),
      ).toBeVisible();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await page.screenshot({
        path: "/tmp/ckocc-update-management-mobile.png",
      });
      await page.setViewportSize({ width: 1280, height: 720 });
    } else {
      await expect(
        page.getByRole("button", { name: "Close without merge" }),
      ).toHaveCount(0);
      await expect(
        page.getByRole("button", { name: "Edit update", exact: true }),
      ).toHaveCount(0);
    }
    page.once("dialog", (dialog) => dialog.dismiss());
    await item.getByRole("button", { name: "Delete update" }).click();
    expect(attempts).toBe(0);
    page.on("dialog", (dialog) => dialog.accept());
    await item.getByRole("button", { name: "Delete update" }).click();
    await expect(item.getByRole("alert")).toContainText(
      "active PR or another action",
    );
    await expect(
      item.getByRole("button", { name: "Delete update" }),
    ).toBeEnabled();
    await item.getByRole("button", { name: "Delete update" }).click();
    await expect(item).toHaveCount(0);
    expect(attempts).toBe(2);
    expect(errors).toEqual([]);
  });
}
test("administrator edits another player's PR in place, persists the draft, and closes with a durable receipt", async ({
  page,
}) => {
  const editSession = {
    id: "edit-session",
    baseCommit: "1".repeat(40),
    baseMapRevision: revision,
    status: "draft",
    createdAt: new Date().toISOString(),
    expiresAt: "2027-01-01T00:00:00Z",
    sourceUrl: "/api/edit-sessions/edit-session/source",
    assets: {},
  };
  let closed = false,
    closeCalls = 0;
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/auth/session")
      return route.fulfill({
        json: {
          user: {
            id: "admin",
            name: "Admin",
            role: "admin",
            email: "a@example.invalid",
          },
        },
      });
    if (path === "/api/notifications")
      return route.fulfill({ json: { notifications: [], unreadCount: 0 } });
    if (path === "/api/map/head")
      return route.fulfill({ json: { revision, commitSha: "1".repeat(40) } });
    if (path === "/api/issues")
      return route.fulfill({ json: { issues: [], hasMore: false } });
    if (path === "/api/updates")
      return route.fulfill({
        json: {
          updates: [],
          otherUpdates: [
            {
              ...pending,
              status: closed ? "closed_unmerged" : "awaiting_review",
              canEdit: !closed,
              canDelete: closed,
            },
          ],
        },
      });
    if (path === "/api/admin/updates/pending/edit") {
      expect(route.request().method()).toBe("POST");
      return route.fulfill({
        json: {
          editSession,
          summary: pending.summary,
          details: "Original details",
          issueNumbers: [42],
        },
      });
    }
    if (path === "/api/edit-sessions/edit-session")
      return route.fulfill({ json: { editSession } });
    if (path === "/api/admin/updates/pending/close") {
      closeCalls++;
      if (closeCalls === 1)
        return route.fulfill({
          status: 409,
          json: { error: { code: "update_busy" } },
        });
      expect(route.request().headers()["idempotency-key"]).toBeTruthy();
      return route.fulfill({ json: { operation: { id: "close-action" } } });
    }
    if (path === "/api/operations/close-action") {
      closed = true;
      return route.fulfill({
        json: {
          operation: {
            id: "close-action",
            kind: "close-update",
            status: "succeeded",
            result: { prNumber: 42 },
          },
        },
      });
    }
    throw new Error(`Unexpected ${path}`);
  });
  await page.goto("/en-us/updates");
  const item = page.locator(".update-accordion");
  await item.locator("summary").click();
  await item.getByRole("button", { name: "Edit update", exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: /^Update summary/ }),
  ).toHaveValue(pending.summary);
  await expect(
    page.getByRole("textbox", { name: /^What changed/ }),
  ).toHaveValue("Original details");
  await expect(
    page.getByRole("button", { name: "Save changes to PR" }),
  ).toBeDisabled();
  await expect(page.getByText(/Editing the existing PR/)).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Save changes to PR" }),
  ).toBeVisible();
  await item.locator("summary").click();
  page.once("dialog", (dialog) => dialog.dismiss());
  await item.getByRole("button", { name: "Close without merge" }).click();
  expect(closeCalls).toBe(0);
  page.once("dialog", (dialog) => dialog.accept());
  await item.getByRole("button", { name: "Close without merge" }).click();
  await expect(item.getByRole("alert")).toContainText(
    "Another action is in progress or its result still needs reconciliation",
  );
  await expect(item.getByRole("alert")).not.toContainText("active PR");
  await expect(
    item.getByRole("button", { name: "Close without merge" }),
  ).toBeEnabled();
  page.once("dialog", (dialog) => dialog.accept());
  await item.getByRole("button", { name: "Close without merge" }).click();
  await expect(item.locator("summary")).toContainText("Closed without merging");
  await item.locator("summary").click();
  await expect(
    item.getByRole("button", { name: "Delete update" }),
  ).toBeVisible();
  await expect(
    item.getByRole("button", { name: "Close without merge" }),
  ).toHaveCount(0);
  expect(closeCalls).toBe(2);
});
