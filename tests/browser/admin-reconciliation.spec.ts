import { expect, test } from "playwright/test";

test("administration hides superseded actions and keeps uncertain work visible", async ({
  page,
}) => {
  let unresolved = true;
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const responses: Record<string, unknown> = {
      "/api/auth/session": {
        user: {
          id: "admin",
          name: "Admin",
          role: "admin",
          email: "admin@example.invalid",
        },
      },
      "/api/notifications": { notifications: [], unreadCount: 0 },
      "/api/admin/accounts": { accounts: [] },
      "/api/admin/settings": { publicWritesPaused: false },
      "/api/admin/invitations": { invitations: [] },
      "/api/admin/email": { jobs: [], feedback: [] },
      "/api/admin/operations": {
        operations: [
          {
            id: "obsolete-action",
            kind: "merge",
            status: "superseded",
            updatedAt: "2026-10-22T12:00:00Z",
          },
          ...(unresolved
            ? [
                {
                  id: "unknown-action",
                  kind: "merge",
                  status: "outcome_unknown",
                  errorCode: "outcome_unknown",
                  updatedAt: "2026-10-22T12:00:00Z",
                },
              ]
            : []),
        ],
      },
    };
    if (!(path in responses)) throw new Error(`Unexpected ${path}`);
    return route.fulfill({ json: responses[path] });
  });
  await page.goto("/en-us/admin");
  const section = page.locator("section").filter({
    has: page.getByRole("heading", { name: "Operations needing attention" }),
  });
  await expect(
    section.getByText("unknown-acti", { exact: true }),
  ).toBeVisible();
  await expect(section.getByText("obsolete-act", { exact: true })).toHaveCount(
    0,
  );
  unresolved = false;
  await page.reload();
  await expect(
    section.getByText("No operations need attention."),
  ).toBeVisible();
});
