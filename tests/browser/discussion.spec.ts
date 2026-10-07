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
              unverified: true,
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
