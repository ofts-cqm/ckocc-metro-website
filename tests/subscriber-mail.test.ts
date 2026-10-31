import assert from "node:assert/strict";
import { before, beforeEach, mock, test } from "node:test";
let state = "pending",
  suppressed = false,
  sendFails = false,
  sends = 0;
let calls: string[] = [];
let rejectionStatus: number | undefined;
let missingId = false;
let messageId: string | null = null;
let claimValues: unknown[] = [];
async function query(sql: string, values: unknown[] = []) {
  if (sql.startsWith("SELECT status,provider_message_id"))
    return {
      rows: [{ status: state, provider_message_id: messageId }],
      rowCount: 1,
    };
  calls.push(sql);
  if (sql.includes("WITH candidates")) {
    claimValues = values;
    if (state !== "pending") return { rows: [], rowCount: 0 };
    state = "sending";
    return {
      rows: [
        {
          invitation_id: "00000000-0000-4000-8000-000000000001",
          email: "user@example.test",
          locale: "en-us",
        },
      ],
      rowCount: 1,
    };
  }
  if (sql.includes("SELECT 1 FROM metro_invitations"))
    return { rows: suppressed ? [] : [{}], rowCount: suppressed ? 0 : 1 };
  if (sql.includes("SET status='submitted'")) {
    state = "submitted";
    messageId = String(values[1]);
  }
  if (sql.includes("SET status='skipped'")) state = "skipped";
  if (
    sql.includes("SET status='outcome_unknown'") &&
    !sql.includes("WHERE status='sending'")
  )
    state = "outcome_unknown";
  return { rows: [], rowCount: 1 };
}
mock.module("../src/server/db", {
  namedExports: { query, transaction: async (fn: any) => fn({ query }) },
});
mock.module("@aws-sdk/client-sesv2", {
  namedExports: {
    SESv2Client: class {
      async send() {
        sends++;
        if (sendFails)
          throw Object.assign(new Error("send failure"), {
            $metadata: { httpStatusCode: rejectionStatus },
          });
        return missingId ? {} : { MessageId: "id" };
      }
      destroy() {}
    },
    SendEmailCommand: class {
      constructor(public input: unknown) {}
    },
  },
});
let mail: typeof import("../src/server/email/subscriber-invitations");
before(async () => {
  mail = await import("../src/server/email/subscriber-invitations");
});
beforeEach(() => {
  state = "pending";
  suppressed = false;
  sendFails = false;
  sends = 0;
  calls = [];
  messageId = null;
  missingId = false;
  rejectionStatus = undefined;
  claimValues = [];
  process.env.EMAIL_NOTIFICATIONS_ENABLED = "true";
  process.env.EMAIL_TOKEN_SECRET = "test-secret-".repeat(4);
  process.env.APP_URL = "https://metro.test";
  process.env.SES_FROM_EMAIL = "mail@example.test";
  process.env.AWS_REGION = "us-east-1";
});
test("parallel invitation workers submit only once", async () => {
  await Promise.all([
    mail.sendPendingSubscriberInvitations(),
    mail.sendPendingSubscriberInvitations(),
  ]);
  assert.equal(sends, 1);
  assert.equal(state, "submitted");
  assert.ok(calls.some((sql) => sql.includes("pg_advisory_xact_lock")));
});
test("ambiguous invitation delivery remains unknown on next repair", async () => {
  sendFails = true;
  await mail.sendPendingSubscriberInvitations();
  assert.equal(state, "outcome_unknown");
  await mail.sendPendingSubscriberInvitations();
  assert.equal(sends, 1);
  assert.equal(state, "outcome_unknown");
});
test("suppressed invitation address is skipped before provider write", async () => {
  suppressed = true;
  await mail.sendPendingSubscriberInvitations();
  assert.equal(sends, 0);
  assert.equal(state, "skipped");
});

const invitationId = "00000000-0000-4000-8000-000000000001";
test("request targets only its invitation and confirms stored provider acceptance", async () => {
  assert.equal(await mail.sendSubscriberInvitation(invitationId), "sent");
  assert.deepEqual(claimValues, [invitationId]);
  assert.equal(await mail.sendSubscriberInvitation(invitationId), "sent");
  assert.equal(sends, 1);
});
test("in-progress invitation is pending, never successful or sent twice", async () => {
  state = "sending";
  assert.equal(await mail.sendSubscriberInvitation(invitationId), "pending");
  assert.equal(sends, 0);
});
test("provider rejection reports failure and cannot be blindly resent", async () => {
  sendFails = true;
  rejectionStatus = 400;
  assert.equal(await mail.sendSubscriberInvitation(invitationId), "failed");
  assert.equal(await mail.sendSubscriberInvitation(invitationId), "failed");
  assert.equal(sends, 1);
});
test("missing provider receipt remains uncertain rather than claiming sent", async () => {
  missingId = true;
  assert.equal(
    await mail.sendSubscriberInvitation(invitationId),
    "outcome_unknown",
  );
  assert.equal(
    await mail.sendSubscriberInvitation(invitationId),
    "outcome_unknown",
  );
  assert.equal(sends, 1);
});
test("5xx provider response remains uncertain", async () => {
  sendFails = true;
  rejectionStatus = 503;
  assert.equal(
    await mail.sendSubscriberInvitation(invitationId),
    "outcome_unknown",
  );
});
