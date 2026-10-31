import assert from "node:assert/strict";
import { before, beforeEach, mock, test } from "node:test";
import { AppError } from "../src/server/http";
import { verifiedAuthor } from "../src/server/operations/attribution";
let target: { email: string; role: string; active: boolean } | null;
let activeAdmin = true,
  anotherAdmin = true,
  sending = false;
let ops: {
  status: string;
  live: boolean;
  checkpoint: Record<string, unknown>;
  result: Record<string, unknown>;
}[] = [];
let calls: { sql: string; values: unknown[] }[] = [];
async function query(sql: string, values: unknown[] = []) {
  calls.push({ sql, values });
  if (sql.includes("user_id=$1 AND role='admin'"))
    return { rows: activeAdmin ? [{}] : [], rowCount: activeAdmin ? 1 : 0 };
  if (sql.includes("SELECT u.email,p.role,p.active"))
    return { rows: target ? [target] : [], rowCount: target ? 1 : 0 };
  if (sql.includes("role='admin' AND active AND user_id<>"))
    return { rows: anotherAdmin ? [{}] : [], rowCount: anotherAdmin ? 1 : 0 };
  if (sql.includes("SELECT status,COALESCE(lease_until"))
    return { rows: ops, rowCount: ops.length };
  if (sql.includes("SELECT 1 FROM metro_email_jobs"))
    return { rows: sending ? [{}] : [], rowCount: sending ? 1 : 0 };
  return { rows: [], rowCount: 1 };
}
mock.module("../src/server/db", {
  namedExports: { query, transaction: async (fn: any) => fn({ query }) },
});
mock.module("../src/server/auth/authorize", {
  namedExports: {
    requireAdmin: async () => {
      if (!activeAdmin) throw new AppError("forbidden", "Admin only", 403);
      return { id: "admin" };
    },
  },
});
mock.module("../src/server/security", {
  namedExports: { enforceSameOrigin: () => {} },
});
let deletion: typeof import("../src/server/auth/delete-account");
let route: typeof import("../src/app/api/admin/accounts/[id]/[action]/route");
before(async () => {
  deletion = await import("../src/server/auth/delete-account");
  route = await import("../src/app/api/admin/accounts/[id]/[action]/route");
});
beforeEach(() => {
  target = {
    email: "reader@example.invalid",
    role: "subscriber",
    active: true,
  };
  activeAdmin = true;
  anotherAdmin = true;
  sending = false;
  ops = [];
  calls = [];
});
const changes = () =>
  calls.filter((c) => /^(UPDATE|DELETE|INSERT)/.test(c.sql));
test("deletion removes account credentials but never deletes shared history or delivery evidence", async () => {
  await deletion.deleteAccount("admin", "reader");
  assert.ok(calls.some((c) => c.sql === 'DELETE FROM "user" WHERE id=$1'));
  assert.ok(calls.some((c) => c.values.includes("account.delete")));
  assert.ok(calls.some((c) => c.sql.includes("accountDeleted")));
  assert.equal(
    calls.some((c) =>
      /DELETE FROM metro_(operations|email_jobs|email_daily_slots|email_suppressions|uploads)/.test(
        c.sql,
      ),
    ),
    false,
  );
  assert.ok(calls.some((c) => c.sql.includes("revoked_at=COALESCE")));
});
test("self-deletion and last active administrator deletion are rejected", async () => {
  await assert.rejects(deletion.deleteAccount("admin", "admin"), {
    code: "cannot_delete_self",
  });
  assert.equal(calls.length, 0);
  target!.role = "admin";
  anotherAdmin = false;
  await assert.rejects(deletion.deleteAccount("admin", "reader"), {
    code: "last_admin",
  });
  assert.equal(changes().length, 0);
});
test("authorization is rechecked inside the identity transaction", async () => {
  activeAdmin = false;
  await assert.rejects(deletion.deleteAccount("admin", "reader"), {
    code: "forbidden",
  });
  assert.equal(changes().length, 0);
});
for (const [status, live, checkpoint] of [
  ["succeeded", true, {}],
  ["outcome_unknown", false, {}],
  ["awaiting_review", false, {}],
  ["merged", false, {}],
  ["failed", false, { writeIntent: true }],
] as const) {
  test(`blocks unsafe work: ${status}, live=${live}`, async () => {
    ops = [{ status, live, checkpoint, result: {} }];
    await assert.rejects(deletion.deleteAccount("admin", "reader"), {
      code: "account_delete_busy",
    });
    assert.equal(changes().length, 0);
  });
}
test("in-flight email blocks deletion without resetting uncertainty", async () => {
  sending = true;
  await assert.rejects(deletion.deleteAccount("admin", "reader"), {
    code: "account_delete_busy",
  });
  assert.equal(changes().length, 0);
});
test("missing target makes a repeated deletion harmless", async () => {
  target = null;
  await deletion.deleteAccount("admin", "old-id");
  assert.equal(changes().length, 0);
});
test("route requires confirmation tied to the selected account", async () => {
  const response = await route.POST(
    new Request("https://metro.test/api/admin/accounts/reader/delete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirmation: "wrong-account" }),
    }),
    { params: Promise.resolve({ id: "reader", action: "delete" }) },
  );
  assert.equal(response.status, 422);
  assert.equal(calls.length, 0);
});
test("detached comments retain submission-time trust, not a replacement account role", () => {
  assert.equal(
    verifiedAuthor({
      actor_id: null,
      checkpoint: { accountDeleted: true, authorRole: "collaborator" },
    }),
    true,
  );
  assert.equal(
    verifiedAuthor({
      actor_id: null,
      checkpoint: { accountDeleted: true, authorRole: "subscriber" },
    }),
    false,
  );
  assert.equal(
    verifiedAuthor({
      actor_id: null,
      checkpoint: { authorRole: "collaborator" },
    }),
    false,
  );
});
