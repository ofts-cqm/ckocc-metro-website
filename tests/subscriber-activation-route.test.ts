import assert from "node:assert/strict";
import { before, mock, test } from "node:test";
import { z } from "zod";
mock.module("../src/server/auth/config", {
  namedExports: {
    getAuth: () => ({
      handler: async () => {
        throw new Error("session unavailable");
      },
    }),
    withLoginContext: async (fn: any) => fn(),
  },
});
mock.module("../src/server/auth/invitations", {
  namedExports: {
    redeemSchema: z.object({ token: z.string(), password: z.string() }),
    redeemInvitation: async () => ({
      email: "subscriber@example.test",
      subscribed: true,
    }),
  },
});
mock.module("../src/server/security", {
  namedExports: {
    enforceSameOrigin: () => {},
    requireInvitationAttempt: async () => {},
  },
});
let route: typeof import("../src/app/api/invitations/redeem/route");
before(async () => {
  route = await import("../src/app/api/invitations/redeem/route");
});
test("successful activation returns login fallback when automatic session creation throws", async () => {
  const response = await route.POST(
    new Request("https://metro.test/api/invitations/redeem", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "token", password: "password" }),
    }),
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    subscribed: true,
    signedIn: false,
  });
});
