import { expect, test, type Page } from "playwright/test";
import type { IssueDetail, SessionUser } from "../../src/lib/contracts";

const collaborator: SessionUser = {
  id: "collaborator-id",
  email: "player@example.invalid",
  name: "AccountPlayer",
  role: "collaborator",
};
const createdAt = "2026-10-06T12:00:00Z";

async function mockApi(page: Page, user: SessionUser | null, state = "open") {
  const issue: IssueDetail = {
    number: 42,
    title: "A public station request",
    state: state as IssueDetail["state"],
    kind: "general",
    gameName: "Visitor",
    createdAt,
    updatedAt: createdAt,
    commentsCount: 0,
    labels: ["metro-request", "type:general"],
    url: "https://example.invalid/issues/42",
    locked: false,
    body: "Please add a station.",
  };
  const submissions: Record<string, unknown>[] = [];
  const closeKeys: string[] = [];
  const behavior = { failClose: false, operationStatus: "succeeded" };
  await page.route("https://challenges.cloudflare.com/**", (route) =>
    route.fulfill({
      contentType: "application/javascript",
      body: 'window.turnstile = { render: (_element, options) => { options.callback("test-challenge"); return "test-widget"; }, remove: () => {} };',
    }),
  );
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/auth/session") {
      await route.fulfill({ json: { user } });
    } else if (path === "/api/requests" && request.method() === "POST") {
      submissions.push(request.postDataJSON());
      await route.fulfill({
        status: 202,
        json: { operation: { id: "request-operation" } },
      });
    } else if (path === "/api/issues/42/close" && request.method() === "POST") {
      closeKeys.push(request.headers()["idempotency-key"]);
      expect(request.postDataJSON()).toEqual({});
      await route.fulfill(
        behavior.failClose
          ? { status: 503, json: { error: { code: "SERVICE_UNAVAILABLE" } } }
          : { status: 202, json: { operation: { id: "close-operation" } } },
      );
    } else if (path.startsWith("/api/operations/")) {
      const close = path.endsWith("close-operation");
      if (close && behavior.operationStatus === "succeeded")
        issue.state = "closed";
      await route.fulfill({
        json: {
          operation: {
            id: close ? "close-operation" : "request-operation",
            kind: close ? "close-issue" : "request",
            status: behavior.operationStatus,
            createdAt,
            updatedAt: createdAt,
            result: { number: 42 },
          },
        },
      });
    } else if (path === "/api/issues/42") {
      await route.fulfill({ json: { issue } });
    } else if (path === "/api/issues/42/comments") {
      await route.fulfill({ json: { comments: [], page: 1, hasMore: false } });
    } else {
      throw new Error(`Unexpected API request: ${request.method()} ${path}`);
    }
  });
  return { submissions, closeKeys, behavior };
}

for (const role of ["collaborator", "admin"] as const) {
  test(`${role} sees an immutable account name in both request forms`, async ({
    page,
  }) => {
    const { submissions } = await mockApi(page, { ...collaborator, role });
    await page.addInitScript(() => {
      sessionStorage.setItem(
        "metro:request-draft-v1",
        JSON.stringify({
          kind: "general",
          gameName: "OldDraftPlayer",
          comment: "A saved request",
          lineName: "",
          lineNumber: "",
          lineType: "double-track-rail",
          operation: "add",
          defaultDimension: "overworld",
          stations: [
            {
              id: "first",
              chineseName: "站",
              englishName: "Station",
              x: "1",
              z: "2",
              dimension: "overworld",
            },
          ],
          notes: "",
        }),
      );
    });
    await page.goto("/en-us/requests/new");
    const name = page.getByRole("textbox", {
      name: /^In-game name/,
    });
    await expect(name).toHaveValue("AccountPlayer");
    await expect(name).not.toBeEditable();
    await page.getByRole("button", { name: "Submit request" }).click();
    await expect.poll(() => submissions.length).toBe(1);
    expect(submissions[0].gameName).toBe("AccountPlayer");
    await page.getByRole("button", { name: "Submit another request" }).click();
    await page.getByRole("radio").nth(1).check();
    await expect(name).toHaveValue("AccountPlayer");
    await expect(name).not.toBeEditable();
    await page
      .getByRole("textbox", { name: "Chinese name", exact: true })
      .fill("站");
    await page
      .getByRole("textbox", { name: "X coordinate", exact: true })
      .fill("1");
    await page
      .getByRole("textbox", { name: "Z coordinate", exact: true })
      .fill("2");
    await page.getByRole("button", { name: "Submit request" }).click();
    await expect.poll(() => submissions.length).toBe(2);
    expect(submissions[1]).toMatchObject({
      kind: "line-update",
      gameName: "AccountPlayer",
    });
  });

  test(`${role} can close an open request and see the closed discussion`, async ({
    page,
  }) => {
    const { closeKeys } = await mockApi(page, { ...collaborator, role });
    await page.goto("/en-us/issues/42");
    await page
      .getByRole("button", { name: "Close request", exact: true })
      .click();
    await expect(page.locator(".issue-meta")).toContainText("Closed");
    await expect(
      page.getByText("This discussion is closed to new comments."),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Close request", exact: true }),
    ).toHaveCount(0);
    expect(closeKeys).toHaveLength(1);
  });
}

test("anonymous visitors can choose a name but cannot close requests", async ({
  page,
}) => {
  await mockApi(page, null);
  await page.goto("/en-us/requests/new");
  const name = page.getByRole("textbox", { name: /^In-game name/ });
  await expect(name).toBeEditable();
  await name.fill("Visitor");
  await page.goto("/en-us/issues/42");
  await expect(
    page.getByRole("heading", { name: "A public station request" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Close request", exact: true }),
  ).toHaveCount(0);
});

test("a failed close retains the discussion and retry uses the same operation key", async ({
  page,
}) => {
  const { closeKeys, behavior } = await mockApi(page, collaborator);
  behavior.failClose = true;
  await page.goto("/en-us/issues/42");
  const close = page.getByRole("button", {
    name: "Close request",
    exact: true,
  });
  await close.click();
  await expect(page.locator(".issue-actions [role=alert]")).toBeVisible();
  await expect(page.locator(".issue-meta")).toContainText("Open");
  behavior.failClose = false;
  await close.click();
  await expect(page.locator(".issue-meta")).toContainText("Closed");
  expect(closeKeys).toHaveLength(2);
  expect(closeKeys[0]).toBe(closeKeys[1]);
});

test("closed requests do not offer a close action", async ({ page }) => {
  await mockApi(page, collaborator, "closed");
  await page.goto("/en-us/issues/42");
  await expect(page.locator(".issue-meta")).toContainText("Closed");
  await expect(
    page.getByRole("button", { name: "Close request", exact: true }),
  ).toHaveCount(0);
});
