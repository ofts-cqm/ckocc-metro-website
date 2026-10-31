import assert from "node:assert/strict";
import { before, beforeEach, mock, test } from "node:test";
let role = "subscriber",
  verified = false;
let mutations: { sql: string; values: unknown[] }[] = [];
async function query(sql: string, values: unknown[] = []) {
  if (sql.includes("SELECT p.role"))
    return { rows: [{ role, verified }], rowCount: 1 };
  if (/INSERT|UPDATE/.test(sql)) mutations.push({ sql, values });
  return { rows: [], rowCount: 1 };
}
mock.module("../src/server/db", {
  namedExports: { query, transaction: async (fn: any) => fn({ query }) },
});
mock.module("../src/server/email/jobs", {
  namedExports: { enqueueVerification: async () => {} },
});
let accounts: typeof import("../src/server/email/accounts");
before(async () => {
  accounts = await import("../src/server/email/accounts");
});
beforeEach(() => {
  role = "subscriber";
  verified = false;
  mutations = [];
});
test("demoted unverified subscribers cannot change notification preferences", async () => {
  await assert.rejects(
    accounts.setEmailPreferences("subscriber", {
      enabled: true,
      mapUpdates: true,
      locale: "en-us",
    }),
    { code: "email_unverified" },
  );
  assert.equal(mutations.length, 0);
});
test("verified subscribers can subscribe but cannot enable discussion email", async () => {
  verified = true;
  await accounts.setEmailPreferences("subscriber", {
    enabled: true,
    mapUpdates: true,
    locale: "en-us",
  });
  assert.equal(
    mutations.find((m) =>
      m.sql.includes("INSERT INTO metro_email_preferences"),
    )!.values[1],
    false,
  );
  assert.equal(
    mutations.find((m) => m.sql.includes("SET map_updates"))!.values[1],
    true,
  );
});
test("unverified collaborators retain existing preference behavior pending email verification", async () => {
  role = "collaborator";
  await accounts.setEmailPreferences("collaborator", {
    enabled: true,
    mapUpdates: true,
    locale: "en-us",
  });
  assert.equal(
    mutations.find((m) =>
      m.sql.includes("INSERT INTO metro_email_preferences"),
    )!.values[1],
    true,
  );
});
