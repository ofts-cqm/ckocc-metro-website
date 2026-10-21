import { expect, test, type Page } from "playwright/test";
import type { IssueDetail, OperationStatus } from "../../src/lib/contracts";

// Run `npx playwright install chromium` once, then `npm run test:browser`.
// API calls are intercepted so these tests never create real comments.
const issueNumber = 42;
const operationId = "comment-operation";
const createdAt = "2026-10-06T12:00:00Z";
const issue: IssueDetail = {
  number: issueNumber,
  title: "Station request with a comment",
  state: "open",
  kind: "general",
  gameName: "Player",
  createdAt,
  updatedAt: createdAt,
  commentsCount: 1,
  labels: ["metro-request", "type:general"],
  url: "https://example.invalid/issues/42",
  locked: false,
  body: "Please add a station.",
};

async function mockDiscussion(
  page: Page,
  savedStatus?: OperationStatus,
  failRefresh = false,
  nameVerification: "verified" | "unverified" = "unverified",
) {
  const calls = { issue: 0, comments: 0, operation: 0, refresh: 0 };
  let completed = false;
  const errors: string[] = [];
  const operation = { status: savedStatus ?? "succeeded" };
  page.on("pageerror", (error) => errors.push(error.message));
  const refresh = Promise.withResolvers<void>();

  if (savedStatus) {
    await page.addInitScript(
      ({ issueNumber, operationId }) => {
        sessionStorage.setItem(
          `metro:comment-attempt-${issueNumber}-v1`,
          JSON.stringify({
            digest: "saved-comment",
            key: "saved-idempotency-key",
            token: "test-receipt-token",
            payload: {
              gameName: "Player",
              comment: "Existing comment",
              locale: "en-US",
            },
            receipt: { id: operationId, token: "test-receipt-token" },
          }),
        );
      },
      { issueNumber, operationId },
    );
  }

  await page.route("https://challenges.cloudflare.com/**", (route) =>
    route.fulfill({
      contentType: "application/javascript",
      body: 'window.turnstile = { render: () => "test-widget", remove: () => {} };',
    }),
  );
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() !== "GET") {
      throw new Error(`Unexpected API write: ${path}`);
    }
    if (path === "/api/auth/session") {
      await route.fulfill({ json: { user: null } });
    } else if (path === "/api/mentions") {
      await route.fulfill({ json: { suggestions: [], remaining: 3 } });
    } else if (path === `/api/issues/${issueNumber}`) {
      calls.issue++;
      const isRefresh = completed;
      if (isRefresh) {
        calls.refresh++;
        await refresh.promise;
      }
      await route.fulfill(
        failRefresh && isRefresh
          ? { status: 503, json: { error: { code: "SERVICE_UNAVAILABLE" } } }
          : { json: { issue } },
      );
    } else if (path === `/api/issues/${issueNumber}/comments`) {
      calls.comments++;
      await route.fulfill({
        json: {
          comments: [
            {
              id: 1,
              body: "Existing comment",
              gameName: "Player",
              author: "metro-bot",
              createdAt,
              updatedAt: createdAt,
              nameVerification,
            },
          ],
          page: 1,
          hasMore: false,
        },
      });
    } else if (path === `/api/operations/${operationId}`) {
      calls.operation++;
      if (operation.status === "succeeded") completed = true;
      await route.fulfill({
        json: {
          operation: {
            id: operationId,
            kind: "comment",
            status: operation.status,
            result: { issueNumber },
            createdAt,
            updatedAt: createdAt,
          },
        },
      });
    } else {
      throw new Error(`Unexpected API request: ${path}`);
    }
  });
  return { calls, errors, operation, releaseRefresh: () => refresh.resolve() };
}

test("opening comments without a saved receipt loads once", async ({
  page,
}) => {
  const { calls, errors } = await mockDiscussion(page);
  await page.goto(`/en-us/issues/${issueNumber}`);
  await expect(page.locator(".comment-card")).toHaveText(/Existing comment/);
  await expect(page.locator(".reply-panel textarea")).toBeVisible();
  const settledCalls = { ...calls };
  // Observe long enough for any unwanted request/remount cycle to recur.
  await page.waitForTimeout(500);
  expect(calls).toEqual(settledCalls);
  // React Strict Mode may run initial mount effects twice in development.
  expect(calls.issue).toBeLessThanOrEqual(2);
  expect(calls.comments).toBeLessThanOrEqual(2);
  expect(calls.operation).toBe(0);
  expect(calls.refresh).toBe(0);
  expect(errors).toEqual([]);
});

test("a signed-in comment displays the verified name label", async ({
  page,
}) => {
  await mockDiscussion(page, undefined, false, "verified");
  await page.goto(`/en-us/issues/${issueNumber}`);
  await expect(page.locator(".comment-card .comment-verification")).toHaveText(
    "Submitted name · verified",
  );
});

for (const failRefresh of [false, true]) {
  test(`restored successful comment settles when refresh ${failRefresh ? "fails" : "succeeds"}`, async ({
    page,
  }) => {
    const { calls, errors, releaseRefresh } = await mockDiscussion(
      page,
      "succeeded",
      failRefresh,
    );
    await page.goto(`/en-us/issues/${issueNumber}`);
    await expect.poll(() => calls.refresh).toBe(1);
    try {
      // A background refresh must preserve the form and its completion guard.
      await expect(
        page.getByRole("heading", { name: issue.title }),
      ).toBeVisible();
      await expect(
        page.getByText("Your comment has been posted."),
      ).toBeVisible();
    } finally {
      releaseRefresh();
    }
    await expect(page.locator(".comment-card")).toHaveText(/Existing comment/);
    await page.waitForTimeout(500);
    expect(calls.refresh).toBe(1);
    expect(calls.operation).toBeLessThanOrEqual(2);
    expect(errors).toEqual([]);

    await page.getByRole("button", { name: "Join the conversation" }).click();
    await expect(page.locator(".reply-panel textarea")).toBeVisible();
    expect(
      await page.evaluate(
        (number) =>
          sessionStorage.getItem(`metro:comment-attempt-${number}-v1`),
        issueNumber,
      ),
    ).toBeNull();
  });
}

test("a pending comment completes and refreshes the discussion once", async ({
  page,
}) => {
  const { calls, errors, operation, releaseRefresh } = await mockDiscussion(
    page,
    "accepted",
  );
  await page.goto(`/en-us/issues/${issueNumber}`);
  await expect(page.locator(".operation-progress")).toContainText(
    "Your submission is being processed.",
  );
  await expect.poll(() => calls.operation).toBeGreaterThanOrEqual(1);
  operation.status = "succeeded";
  releaseRefresh();
  await expect(page.getByText("Your comment has been posted.")).toBeVisible();
  await expect(page.locator(".comment-card")).toHaveText(/Existing comment/);
  await page.waitForTimeout(500);
  expect(calls.refresh).toBe(1);
  expect(calls.operation).toBeLessThanOrEqual(3);
  expect(errors).toEqual([]);
});

test("a guest can reply and select a mention with the remaining allowance visible", async ({
  page,
}) => {
  const submissions: Record<string, unknown>[] = [];
  await page.route("https://challenges.cloudflare.com/**", (route) =>
    route.fulfill({
      contentType: "application/javascript",
      body: 'window.turnstile = { render: (_element, options) => { options.callback("test-challenge"); return "test-widget"; }, remove: () => {} };',
    }),
  );
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const method = route.request().method();
    if (path === "/api/auth/session")
      await route.fulfill({ json: { user: null } });
    else if (path === "/api/mentions")
      await route.fulfill({
        json: {
          suggestions: new URL(route.request().url()).searchParams
            .get("q")
            ?.trim()
            .toLowerCase()
            .startsWith("ali")
            ? [{ id: "alice", name: "Alice Player", role: "collaborator" }]
            : [],
          remaining: 3,
        },
      });
    else if (path === `/api/issues/${issueNumber}`)
      await route.fulfill({ json: { issue } });
    else if (path === `/api/issues/${issueNumber}/comments` && method === "GET")
      await route.fulfill({
        json: {
          comments: [
            {
              id: 1,
              body: "A question",
              gameName: "Another player",
              author: "metro-bot",
              createdAt,
              updatedAt: createdAt,
              nameVerification: "unverified",
            },
          ],
          page: 1,
          hasMore: false,
        },
      });
    else if (
      path === `/api/issues/${issueNumber}/comments` &&
      method === "POST"
    ) {
      submissions.push(route.request().postDataJSON());
      await route.fulfill({
        status: 202,
        json: { operation: { id: operationId } },
      });
    } else if (path === `/api/operations/${operationId}`)
      await route.fulfill({
        json: {
          operation: {
            id: operationId,
            status: "succeeded",
            result: { number: issueNumber },
          },
        },
      });
    else throw new Error(`Unexpected API request: ${method} ${path}`);
  });
  await page.goto(`/en-us/issues/${issueNumber}`);
  await page.getByRole("button", { name: "Reply", exact: true }).click();
  await expect(page.getByText("Replying to Another player")).toBeVisible();
  await expect(page.getByText("3 mentions remaining today.")).toBeVisible();
  await page.locator(".reply-panel input[name=gameName]").fill("Visitor");
  await page.locator(".reply-panel textarea").fill("Hello @Nobody");
  await expect(page.getByText("User not found")).toBeVisible();
  await page.locator(".reply-panel textarea").fill("Hello @Ali");
  await page.getByRole("option", { name: /Alice Player/ }).click();
  await expect(page.locator(".reply-panel textarea")).toHaveValue(
    "Hello @Alice Player",
  );
  await page.getByRole("button", { name: "Post comment" }).click();
  await expect.poll(() => submissions.length).toBe(1);
  expect(submissions[0].replyToCommentId).toBe(1);
  expect(submissions[0].mentions).toEqual([
    { userId: "alice", start: 6, end: 19 },
  ]);
});

test("an administrator sees reply and line request notifications", async ({
  page,
}) => {
  let marked = false;
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/auth/session")
      await route.fulfill({
        json: {
          user: {
            id: "alice",
            name: "Alice Player",
            email: "alice@example.invalid",
            role: "admin",
          },
        },
      });
    else if (path === "/api/notifications") {
      if (route.request().method() === "POST") marked = true;
      await route.fulfill({
        json: {
          notifications: [
            {
              id: "00000000-0000-4000-8000-000000000001",
              kind: "reply",
              sender: "Visitor",
              issueNumber,
              createdAt,
              read: marked,
            },
            {
              id: "00000000-0000-4000-8000-000000000002",
              kind: "line-add",
              sender: "Builder",
              issueNumber,
              createdAt,
              read: marked,
            },
            {
              id: "00000000-0000-4000-8000-000000000003",
              kind: "line-update",
              sender: "Editor",
              issueNumber,
              createdAt,
              read: marked,
            },
          ],
          unreadCount: marked ? 0 : 3,
        },
      });
    } else if (path === `/api/issues/${issueNumber}`)
      await route.fulfill({ json: { issue } });
    else if (path === `/api/issues/${issueNumber}/comments`)
      await route.fulfill({
        json: {
          comments: [],
          page: 1,
          hasMore: false,
        },
      });
    else if (path === "/api/mentions")
      await route.fulfill({ json: { suggestions: [], remaining: null } });
    else throw new Error(`Unexpected API request: ${path}`);
  });
  await page.goto(`/en-us/issues/${issueNumber}`);
  await page.getByRole("button", { name: "Notifications" }).click();
  await expect(
    page.getByRole("link", { name: "Visitor replied to you" }),
  ).toHaveAttribute("href", `/en-us/issues/${issueNumber}`);
  await expect(
    page.getByRole("link", { name: "Builder requested a new line" }),
  ).toHaveAttribute("href", `/en-us/issues/${issueNumber}`);
  await expect(
    page.getByRole("link", { name: "Editor requested a line update" }),
  ).toHaveAttribute("href", `/en-us/issues/${issueNumber}`);
  await expect.poll(() => marked).toBe(true);
});
