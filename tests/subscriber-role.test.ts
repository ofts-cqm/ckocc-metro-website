import assert from "node:assert/strict";
import { before, beforeEach, mock, test } from "node:test";
let target = { role: "subscriber", active: true, name: "Visitor" };
let remaining = true,
  conflict = false,
  actor = true;
let calls: { sql: string; values: unknown[] }[] = [];
async function query(sql: string, values: unknown[] = []) {
  calls.push({ sql, values });
  if (sql.includes("user_id=$1 AND role='admin'"))
    return { rows: actor ? [{}] : [], rowCount: actor ? 1 : 0 };
  if (sql.includes("SELECT p.role,p.active,u.name"))
    return { rows: [target], rowCount: 1 };
  if (sql.includes("role='admin' AND active AND user_id<>"))
    return { rows: remaining ? [{}] : [], rowCount: remaining ? 1 : 0 };
  if (sql.includes('SELECT 1 FROM "user"'))
    return { rows: conflict ? [{}] : [], rowCount: conflict ? 1 : 0 };
  return { rows: [], rowCount: 1 };
}
mock.module("../src/server/db", {
  namedExports: { query, transaction: async (fn: any) => fn({ query }) },
});
mock.module("../src/server/auth/authorize", {
  namedExports: { requireAdmin: async () => ({ id: "actor", role: "admin" }) },
});
mock.module("../src/server/security", {
  namedExports: { enforceSameOrigin: () => {} },
});
let route: typeof import("../src/app/api/admin/accounts/[id]/[action]/route");
before(async () => {
  route = await import("../src/app/api/admin/accounts/[id]/[action]/route");
});
beforeEach(() => {
  calls = [];
  target = { role: "subscriber", active: true, name: "Visitor" };
  remaining = true;
  conflict = false;
  actor = true;
});
async function change(role: string, displayName?: string) {
  return route.POST(
    new Request("https://metro.test/api/admin/accounts/user/role", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ role, displayName }),
    }),
    { params: Promise.resolve({ id: "user", action: "role" }) },
  );
}
test("promotion preserves email preferences and revokes sessions", async () => {
  assert.equal((await change("admin")).status, 200);
  assert.ok(
    calls.some(
      (c) =>
        c.sql.includes("UPDATE metro_profiles SET role=") &&
        c.values[1] === "admin",
    ),
  );
  assert.ok(calls.some((c) => c.sql.includes('DELETE FROM "session"')));
  assert.equal(
    calls.some((c) => c.sql.includes("metro_email_preferences")),
    false,
  );
  assert.ok(
    calls.some(
      (c) =>
        c.sql.includes("INSERT INTO metro_audit") &&
        c.values.includes("account.role.subscriber.admin"),
    ),
  );
});
test("last active administrator cannot be demoted", async () => {
  target.role = "admin";
  remaining = false;
  assert.equal((await change("subscriber")).status, 409);
  assert.equal(
    calls.some((c) => c.sql.includes("UPDATE metro_profiles SET role=")),
    false,
  );
});
test("demotion succeeds with another active administrator", async () => {
  target.role = "admin";
  assert.equal((await change("subscriber")).status, 200);
  assert.ok(calls.some((c) => c.sql.includes('DELETE FROM "session"')));
});
test("promotion rejects account name conflicts before mutation", async () => {
  conflict = true;
  assert.equal((await change("collaborator")).status, 409);
  assert.equal(
    calls.some((c) => c.sql.includes("UPDATE metro_profiles SET role=")),
    false,
  );
});
test("administrator role is rechecked after acquiring identity lock", async () => {
  actor = false;
  assert.equal((await change("admin")).status, 403);
  assert.equal(
    calls.some((c) => c.sql.includes("UPDATE metro_profiles SET role=")),
    false,
  );
});

test("promotion accepts corrected name without rewriting historical contributions", async () => {
  assert.equal((await change("collaborator", " NewName ")).status, 200);
  const check = calls.find((c) => c.sql.includes('SELECT 1 FROM "user"'))!;
  assert.equal(check.values[0], "NewName");
  assert.match(check.sql, /p.role IN \('collaborator','admin'\)/);
  assert.ok(
    calls.some(
      (c) =>
        c.sql.includes('UPDATE "user" SET name=') && c.values[1] === "NewName",
    ),
  );
  assert.ok(
    calls.some(
      (c) =>
        c.sql.includes("INSERT INTO metro_audit") &&
        c.values.includes("account.name.change"),
    ),
  );
  assert.equal(
    calls.some((c) => /UPDATE metro_(operations|comment)/.test(c.sql)),
    false,
  );
  assert.ok(calls.some((c) => c.sql.includes('DELETE FROM "session"')));
});
test("a conflicting replacement name leaves both name and role unchanged", async () => {
  conflict = true;
  assert.equal((await change("admin", "TakenName")).status, 409);
  assert.equal(
    calls.some(
      (c) =>
        c.sql.includes('UPDATE "user"') ||
        c.sql.includes("UPDATE metro_profiles SET role="),
    ),
    false,
  );
});
test("replacement name cannot bypass name validation", async () => {
  assert.equal((await change("collaborator", "bad\u0000name")).status, 422);
  assert.equal(calls.length, 0);
});
