import assert from "node:assert/strict";
import { afterEach, before, beforeEach, mock, test } from "node:test";

let transactions = 0;
mock.module("../src/server/db/index.ts", {
  namedExports: {
    transaction: async (run: (client: unknown) => Promise<unknown>) => {
      transactions++;
      return run({ query: async () => ({ rows: [{ count: 1000 }] }) });
    },
    query: async () => ({ rows: [{ public_writes_paused: false }] }),
  },
});
mock.module("../src/server/auth/config.ts", {
  namedExports: { siteOrigin: () => "http://localhost:3000" },
});
let security: typeof import("../src/server/security");
before(async () => {
  security = await import("../src/server/security");
});

const env = process.env as Record<string, string | undefined>;
const keys = ["NODE_ENV", "DISABLE_RATE_LIMITS", "ABUSE_HASH_SECRET"];
let saved: (string | undefined)[];
beforeEach(() => {
  saved = keys.map((key) => env[key]);
  transactions = 0;
  env.ABUSE_HASH_SECRET = "a".repeat(32);
});
afterEach(() => {
  keys.forEach((key, index) => {
    if (saved[index] === undefined) delete env[key];
    else env[key] = saved[index];
  });
});
const limits = [
  { key: "request-hour:local-development", max: 3, seconds: 3600 },
];

test("the explicit testing switch skips counters in development and test", async () => {
  env.DISABLE_RATE_LIMITS = "true";
  for (const mode of ["development", "test"]) {
    env.NODE_ENV = mode;
    await security.enforceRateLimits(limits);
  }
  assert.equal(transactions, 0);
});

test("limits remain enforced by default, when restored, and in production", async () => {
  for (const [mode, flag] of [
    ["development", undefined],
    ["development", "false"],
    ["development", "1"],
    ["production", "true"],
    [undefined, "true"],
  ]) {
    if (mode === undefined) delete env.NODE_ENV;
    else env.NODE_ENV = mode;
    if (flag === undefined) delete env.DISABLE_RATE_LIMITS;
    else env.DISABLE_RATE_LIMITS = flag;
    await assert.rejects(security.enforceRateLimits(limits), {
      code: "rate_limited",
      status: 429,
    });
  }
  assert.equal(transactions, 5);
});

test("bypassing rate limits still requires a same-origin request and challenge", async () => {
  env.NODE_ENV = "development";
  env.DISABLE_RATE_LIMITS = "true";
  const request = (origin: string) =>
    new Request("http://localhost:3000/api/requests", {
      method: "POST",
      headers: { origin },
    });
  await assert.rejects(
    security.requireAnonymousWrite(
      request("https://example.invalid"),
      "request",
      "",
      "test",
    ),
    { code: "forbidden_origin", status: 403 },
  );
  await assert.rejects(
    security.requireAnonymousWrite(
      request("http://localhost:3000"),
      "request",
      "",
      "test",
    ),
    { code: "challenge_failed", status: 422 },
  );
  assert.equal(transactions, 0);
});
