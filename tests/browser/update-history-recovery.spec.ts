import { expect, test } from "playwright/test";
const revision = `sha256:${"a".repeat(64)}`;
const old = {
  id: "old-failed-update",
  summary: "Rejected earlier",
  status: "failed",
  errorCode: "unsupported_map_format",
  canRevise: true,
  baseMapRevision: revision,
  createdAt: "2026-10-22T11:13:30Z",
  updatedAt: "2026-10-22T11:13:32Z",
};
const recovered = {
  id: "11111111-1111-4111-8111-111111111111",
  baseCommit: "1".repeat(40),
  baseMapRevision: revision,
  status: "draft",
  createdAt: "2026-10-22T22:00:00Z",
  expiresAt: "2026-10-29T22:00:00Z",
  sourceUrl: "/api/edit-sessions/source",
  assets: {},
};
for (const existing of [false, true]) {
  test(
    existing
      ? "history recovery confirms before replacing an open draft"
      : "a failed historical update can reopen without a saved browser receipt",
    async ({ page }) => {
      const pageErrors: string[] = [];
      page.on("pageerror", (error) => pageErrors.push(error.message));
      let revisions = 0;
      const state = { fail: true };
      if (existing)
        await page.addInitScript(
          ({ recovered }) => {
            sessionStorage.setItem(
              "metro:update-history-player-v1",
              JSON.stringify({
                session: recovered,
                summary: "Current unsent draft",
                details: "Keep until confirmed",
                issueNumbers: [],
                jsonName: "",
                pngName: "",
                idempotencyKey: "key",
                submittedOperation: null,
              }),
            );
          },
          { recovered },
        );
      await page.route("**/api/**", async (route) => {
        const path = new URL(route.request().url()).pathname;
        if (path === "/api/auth/session")
          return route.fulfill({
            json: {
              user: {
                id: "history-player",
                name: "Player",
                email: "p@example.invalid",
                role: "collaborator",
              },
            },
          });
        if (path === "/api/notifications")
          return route.fulfill({ json: { notifications: [], unreadCount: 0 } });
        if (path === "/api/map/head")
          return route.fulfill({
            json: { revision, commitSha: "1".repeat(40) },
          });
        if (path === "/api/updates")
          return route.fulfill({ json: { updates: [old] } });
        if (path === "/api/issues")
          return route.fulfill({ json: { issues: [], hasMore: false } });
        if (path.startsWith("/api/edit-sessions/"))
          return route.fulfill({ json: { editSession: recovered } });
        if (path === "/api/operations/old-failed-update/revise") {
          revisions++;
          expect(route.request().method()).toBe("POST");
          if (state.fail)
            return route.fulfill({
              status: 503,
              json: { error: { code: "provider_unavailable" } },
            });
          return route.fulfill({
            json: {
              editSession: recovered,
              summary: "Rejected earlier",
              details: "Original details",
              issueNumbers: [42],
            },
          });
        }
        throw new Error(`Unexpected request ${path}`);
      });
      await page.goto("/en-us/updates");
      const item = page
        .locator(".update-accordion")
        .filter({ hasText: "Rejected earlier" });
      await item.locator("summary").click();
      await expect(
        item.getByText(/result of a previous submission attempt/),
      ).toBeVisible();
      const button = item.getByRole("button", { name: "Edit and resubmit" });
      if (existing) {
        page.once("dialog", (dialog) => dialog.dismiss());
        await button.click();
        expect(revisions).toBe(0);
        await expect(
          page.getByRole("textbox", { name: /^Update summary/ }),
        ).toHaveValue("Current unsent draft");
        page.on("dialog", (dialog) => dialog.accept());
      }
      await button.click();
      await expect(
        item
          .getByRole("alert")
          .filter({ hasText: "This service is not ready yet" }),
      ).toBeVisible();
      await expect(button).toBeEnabled();
      expect(revisions).toBe(1);
      state.fail = false;
      await button.click();
      await expect(
        page.getByText(/Your draft is editable again/),
      ).toBeVisible();
      expect(revisions).toBe(2);
      await expect(
        page.getByRole("textbox", { name: /^Update summary/ }),
      ).toHaveValue("Rejected earlier");
      await expect(
        page.getByRole("textbox", { name: /^What changed/ }),
      ).toHaveValue("Original details");
      await expect(
        page.locator(".update-form input[type=file]").first(),
      ).toBeEnabled();
      await expect(
        page.locator(".update-form button[type=submit]"),
      ).toBeDisabled();
      const draft = await page.evaluate(() =>
        JSON.parse(sessionStorage.getItem("metro:update-history-player-v1")!),
      );
      expect(draft.session.baseMapRevision).toBe(revision);
      expect(draft.issueNumbers).toEqual([42]);
      expect(draft.submittedOperation).toBeNull();
      expect(pageErrors).toEqual([]);
      await page.screenshot({
        path: `/tmp/ckocc-history-recovery-${existing}.png`,
        fullPage: true,
      });
    },
  );
}
