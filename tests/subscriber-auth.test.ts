import assert from "node:assert/strict";
import { before, beforeEach, mock, test } from "node:test";
let calls: { sql: string; values: unknown[] }[] = [];
let existing = false,
  conflict = false;
let invitation: Record<string, unknown>;
let pending: Record<string, unknown> | null = null;
async function query(sql: string, values: unknown[] = []) {
  calls.push({ sql, values });
  if (sql.includes("SELECT id,kind,display_name FROM metro_invitations"))
    return { rows: pending ? [pending] : [], rowCount: pending ? 1 : 0 };
  if (sql.includes("SELECT * FROM metro_invitations"))
    return {
      rows:
        invitation.consumed_at && sql.includes("expires_at > now()")
          ? []
          : [invitation],
      rowCount: 1,
    };
  if (sql.includes('SELECT id FROM "user"'))
    return {
      rows: existing ? [{ id: "existing" }] : [],
      rowCount: existing ? 1 : 0,
    };
  if (sql.includes('SELECT 1 FROM "user"'))
    return { rows: conflict ? [{}] : [], rowCount: conflict ? 1 : 0 };
  if (sql.includes("SET consumed_at")) invitation.consumed_at = new Date();
  return { rows: [], rowCount: 0 };
}
mock.module("../src/server/db", {
  namedExports: { query, transaction: async (fn: any) => fn({ query }) },
});
mock.module("../src/server/auth/config", {
  namedExports: { siteOrigin: () => "https://metro.test" },
});
mock.module("../src/server/auth/password", {
  namedExports: {
    MIN_PASSWORD_LENGTH: 8,
    MAX_PASSWORD_LENGTH: 128,
    hashPassword: async () => "hashed-password",
  },
});
mock.module("../src/server/email/subscriber-invitations", {
  namedExports: { subscriberInvitationToken: () => "t".repeat(43) },
});
let auth: typeof import("../src/server/auth/invitations");
before(async () => {
  auth = await import("../src/server/auth/invitations");
});
beforeEach(() => {
  calls = [];
  existing = false;
  conflict = false;
  pending = null;
  invitation = {
    id: "invitation",
    email: "subscriber@example.test",
    display_name: "Visitor",
    role: "subscriber",
    kind: "subscribe",
    locale: "en-us",
    expires_at: new Date(Date.now() + 60000),
    consumed_at: null,
    revoked_at: null,
  };
});
test("public subscription cannot accept a privileged role", () => {
  assert.throws(() =>
    auth.subscriptionSchema.parse({
      email: "a@example.test",
      displayName: "A",
      role: "admin",
      challenge: "token",
      idempotencyKey: "00000000-0000-4000-8000-000000000001",
    }),
  );
});
test("subscription request never modifies an existing account", async () => {
  existing = true;
  await assert.rejects(
    auth.requestSubscription({
      email: "subscriber@example.test",
      displayName: "Visitor",
      locale: "en-US",
      challenge: "token",
      idempotencyKey: "00000000-0000-4000-8000-000000000001",
    }),
    { code: "subscription_email_taken" },
  );
  assert.equal(
    calls.some((c) => /INSERT|UPDATE/.test(c.sql)),
    false,
  );
});
test("subscriber activation verifies mailbox, records map consent, and consumes link once", async () => {
  const input = { token: "t".repeat(43), password: "password123" };
  const result = await auth.redeemInvitation(input);
  assert.equal(result.subscribed, true);
  const user = calls.find((c) => c.sql.includes('INSERT INTO "user"'))!;
  assert.equal(user.values[3], true);
  assert.equal(
    calls.find((c) => c.sql.includes("INSERT INTO metro_profiles"))!.values[1],
    "subscriber",
  );
  assert.ok(calls.some((c) => c.sql.includes("map_consent_at")));
  await assert.rejects(
    auth.redeemInvitation(input),
    /invalid, expired, or already used/,
  );
});
test("redeeming a pending subscriber invitation rechecks protected name conflicts", async () => {
  conflict = true;
  await assert.rejects(
    auth.redeemInvitation({ token: "t".repeat(43), password: "password123" }),
    /name conflicts/,
  );
  assert.equal(
    calls.some((c) => c.sql.includes('INSERT INTO "user"')),
    false,
  );
});
test("ordinary administrator invitation does not verify email or enable subscription", async () => {
  invitation.kind = "invite";
  invitation.role = "collaborator";
  const result = await auth.redeemInvitation({
    token: "t".repeat(43),
    password: "password123",
  });
  assert.equal(result.subscribed, false);
  assert.equal(
    calls.find((c) => c.sql.includes('INSERT INTO "user"'))!.values[3],
    false,
  );
  assert.equal(
    calls.some((c) => c.sql.includes("INSERT INTO metro_email_preferences")),
    false,
  );
});

const subscriptionInput = {
  email: "subscriber@example.test",
  displayName: "Visitor",
  locale: "en-US" as const,
  challenge: "token",
  idempotencyKey: "00000000-0000-4000-8000-000000000001",
};
test("protected name produces an explicit error before creating delivery intent", async () => {
  conflict = true;
  await assert.rejects(auth.requestSubscription(subscriptionInput), {
    code: "name_conflict",
  });
  assert.equal(
    calls.some((c) => /INSERT|UPDATE/.test(c.sql)),
    false,
  );
});
test("retry reuses the same subscriber invitation without creating another email", async () => {
  pending = {
    id: "same-invitation",
    kind: "subscribe",
    display_name: "Visitor",
  };
  assert.equal(
    await auth.requestSubscription(subscriptionInput),
    "same-invitation",
  );
  assert.equal(
    calls.some((c) => /INSERT|UPDATE/.test(c.sql)),
    false,
  );
});
test("different pending invitation details are explicitly reported without replacement", async () => {
  pending = {
    id: "same-invitation",
    kind: "subscribe",
    display_name: "Another name",
  };
  await assert.rejects(auth.requestSubscription(subscriptionInput), {
    code: "subscription_invitation_pending",
  });
  assert.equal(
    calls.some((c) => /INSERT|UPDATE/.test(c.sql)),
    false,
  );
});
test("subscriber-only names remain available and the invitation role stays subscriber", async () => {
  const id = await auth.requestSubscription(subscriptionInput);
  assert.equal(typeof id, "string");
  assert.ok(
    calls
      .find((c) => c.sql.includes("SELECT 1 FROM"))
      ?.sql.includes("p.role IN ('collaborator','admin')"),
  );
  assert.ok(
    calls.some(
      (c) => c.sql.includes("'subscribe'") && c.sql.includes("'subscriber'"),
    ),
  );
});
