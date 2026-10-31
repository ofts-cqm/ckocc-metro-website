import assert from "node:assert/strict";
import { before, beforeEach, mock, test } from "node:test";
import { z } from "zod";
import { AppError } from "../src/server/http";
let delivery = "sent",
  requested = 0,
  sends = 0;
let requestError: string | null = null;
let blocker: Promise<void> | null = null;
let challengeFails = false;
mock.module("../src/server/auth/invitations", {
  namedExports: {
    subscriptionSchema: z.object({
      email: z.string().email(),
      displayName: z.string().min(1),
      challenge: z.string(),
      idempotencyKey: z.string(),
      locale: z.string(),
    }),
    requestSubscription: async () => {
      requested++;
      if (requestError) throw new AppError(requestError, "Conflict", 409);
      return "invitation-id";
    },
  },
});
mock.module("../src/server/email/subscriber-invitations", {
  namedExports: {
    sendSubscriberInvitation: async (id: string) => {
      assert.equal(id, "invitation-id");
      sends++;
      if (blocker) await blocker;
      return delivery;
    },
  },
});
mock.module("../src/server/email/config", {
  namedExports: { emailEnabled: () => true },
});
mock.module("../src/server/security", {
  namedExports: {
    enforceSameOrigin: () => {},
    enforceRateLimits: async () => {},
    requireAnonymousWrite: async () => {
      if (challengeFails)
        throw new AppError("challenge_failed", "Challenge failed", 403);
    },
  },
});
let route: typeof import("../src/app/api/subscriptions/route");
before(async () => {
  route = await import("../src/app/api/subscriptions/route");
});
beforeEach(() => {
  delivery = "sent";
  requested = 0;
  sends = 0;
  requestError = null;
  blocker = null;
  challengeFails = false;
});
const request = (email = "person@example.test") =>
  new Request("https://metro.test/api/subscriptions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email,
      displayName: "Person",
      locale: "en-US",
      challenge: "challenge",
      idempotencyKey: "key",
    }),
  });
test("success waits for provider acceptance instead of returning queued success", async () => {
  let release!: () => void;
  blocker = new Promise((resolve) => {
    release = resolve;
  });
  let returned = false;
  const responsePromise = route.POST(request()).then((r) => {
    returned = true;
    return r;
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(returned, false);
  release();
  const response = await responsePromise;
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, delivery: "sent" });
});
for (const [state, code, status] of [
  ["pending", "subscription_delivery_pending", 409],
  ["failed", "subscription_delivery_failed", 503],
  ["outcome_unknown", "subscription_delivery_unknown", 503],
] as const) {
  test(`${state} is not reported as success`, async () => {
    delivery = state;
    const response = await route.POST(request());
    assert.equal(response.status, status);
    assert.equal((await response.json()).error.code, code);
  });
}
for (const code of [
  "subscription_email_taken",
  "name_conflict",
  "subscription_invitation_pending",
]) {
  test(`${code} prevents sending`, async () => {
    requestError = code;
    const response = await route.POST(request());
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error.code, code);
    assert.equal(sends, 0);
  });
}
test("invalid address and failed challenge cannot inspect accounts or send", async () => {
  assert.equal((await route.POST(request("invalid"))).status, 422);
  challengeFails = true;
  assert.equal((await route.POST(request())).status, 403);
  assert.equal(requested, 0);
  assert.equal(sends, 0);
});
