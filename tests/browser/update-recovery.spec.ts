import { expect, test } from "playwright/test";
const revision = `sha256:${"a".repeat(64)}`;
const session = {
  id: "11111111-1111-4111-8111-111111111111",
  baseCommit: "1".repeat(40),
  baseMapRevision: revision,
  status: "submitted",
  sourceUrl: "/api/edit-sessions/source",
  createdAt: "2026-10-22T10:00:00Z",
  expiresAt: "2026-10-29T10:00:00Z",
  assets: {
    json: { pathname: "staging/map.json", bytes: 100 },
    png: { pathname: "staging/map.png", bytes: 100 },
  },
};
for (const failed of [true, false]) {
  test(
    failed
      ? "Try again restores editable text and pinned base with required files"
      : "invalid submission and upload quota rejection keep the draft editable",
    async ({ page }) => {
      let revisions = 0,
        submissions = 0,
        quotaAttempts = 0;
      const recovered = {
        ...session,
        id: "22222222-2222-4222-8222-222222222222",
        status: "draft",
        assets: {},
      };
      await page.addInitScript(
        ({ session, failed }) => {
          if (!sessionStorage.getItem("metro:update-recovery-player-v1"))
            sessionStorage.setItem(
              "metro:update-recovery-player-v1",
              JSON.stringify({
                session: { ...session, status: failed ? "submitted" : "draft" },
                summary: "Preserved map summary",
                details: "Preserved explanation",
                issueNumbers: [],
                jsonName: "map.json",
                pngName: "map.png",
                idempotencyKey: "44444444-4444-4444-8444-444444444444",
                submittedOperation: failed ? "failed-update" : null,
              }),
            );
        },
        { session, failed },
      );
      await page.route("**/api/**", async (route) => {
        const path = new URL(route.request().url()).pathname;
        if (path === "/api/auth/session")
          return route.fulfill({
            json: {
              user: {
                id: "recovery-player",
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
        if (path === "/api/updates") {
          if (route.request().method() === "POST") {
            submissions++;
            return route.fulfill({
              status: 422,
              json: { error: { code: "unsupported_map_format" } },
            });
          }
          return route.fulfill({ json: { updates: [] } });
        }
        if (path === "/api/uploads/reserve") {
          quotaAttempts++;
          return route.fulfill({
            status: 429,
            json: { error: { code: "storage_quota_exceeded" } },
          });
        }
        if (path === "/api/issues")
          return route.fulfill({ json: { issues: [], hasMore: false } });
        if (path.startsWith("/api/edit-sessions/"))
          return route.fulfill({
            json: {
              editSession: path.includes(recovered.id) ? recovered : session,
            },
          });
        if (path.endsWith("/revise")) {
          revisions++;
          expect(route.request().method()).toBe("POST");
          return route.fulfill({
            json: {
              editSession: recovered,
              summary: "Preserved map summary",
              details: "Preserved explanation",
              issueNumbers: [],
            },
          });
        }
        if (path === "/api/operations/failed-update")
          return route.fulfill({
            json: {
              operation: {
                id: "failed-update",
                kind: "update",
                status: "failed",
                errorCode: "unsupported_map_format",
                canRevise: true,
              },
            },
          });
        throw new Error(`Unexpected request ${path}`);
      });
      await page.goto("/en-us/updates");
      if (failed) {
        await expect(
          page.getByText(/expected RMP document structure/),
        ).toBeVisible();
        await page
          .getByRole("button", { name: "Try again", exact: true })
          .click();
        await expect(
          page.getByText(/Your draft is editable again/),
        ).toBeVisible();
        expect(revisions).toBe(1);
      } else {
        await page.locator("button[type=submit]").click();
        await expect(
          page.getByText(/expected RMP document structure/),
        ).toBeVisible();
        expect(submissions).toBe(1);
        await expect(page.locator(".update-form")).toBeVisible();
      }
      await expect(
        page.getByRole("textbox", { name: /^Update summary/ }),
      ).toHaveValue("Preserved map summary");
      await expect(
        page.getByRole("textbox", { name: /^What changed/ }),
      ).toHaveValue("Preserved explanation");
      if (!failed) {
        const file = page.locator(
          'input[type=file][accept=".json,application/json"]',
        );
        for (let attempt = 1; attempt <= 2; attempt++) {
          await file.setInputFiles({
            name: "map.json",
            mimeType: "application/json",
            buffer: Buffer.from("{}"),
          });
          await expect(
            page.locator('.update-form [role="alert"]'),
          ).toContainText("Upload storage is full");
          await expect(file).toBeEnabled();
          expect(quotaAttempts).toBe(attempt);
        }
        await expect(
          page.getByRole("textbox", { name: /^Update summary/ }),
        ).toHaveValue("Preserved map summary");
      }
      if (failed) {
        await expect(page.locator("button[type=submit]")).toBeDisabled();
        await page.reload();
        await expect(
          page.getByRole("textbox", { name: /^Update summary/ }),
        ).toHaveValue("Preserved map summary");
        await expect(page.locator("button[type=submit]")).toBeDisabled();
        await page.screenshot({
          path: "/tmp/ckocc-recovered-update.png",
          fullPage: true,
        });
      }
      expect(
        await page.evaluate(
          () =>
            JSON.parse(
              sessionStorage.getItem("metro:update-recovery-player-v1")!,
            ).session.baseMapRevision,
        ),
      ).toBe(revision);
    },
  );
}
