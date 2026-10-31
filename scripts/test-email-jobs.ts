/** Isolated PostgreSQL acceptance for recipient discovery and durable sender gates; no network sends. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Client } from "pg";
import { resolve } from "node:path";

async function main() {
  const connection =
    process.env.EMAIL_TEST_DATABASE_URL || process.env.DATABASE_URL;
  if (!connection) throw new Error("A local test database is required.");
  const url = new URL(connection);
  if (
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    !/(test|dev)/i.test(url.pathname)
  )
    throw new Error("Email tests require a local test/dev database.");
  const schema = `email_jobs_${randomUUID().replaceAll("-", "")}`;
  const admin = new Client({ connectionString: connection });
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${schema}`);
  url.searchParams.set("options", `-c search_path=${schema}`);
  process.env.DATABASE_URL = url.toString();
  process.env.EMAIL_NOTIFICATIONS_ENABLED = "false";
  process.env.EMAIL_TOKEN_SECRET =
    "isolated-email-test-secret-with-over-32-characters";
  process.env.AWS_REGION = "us-east-1";
  process.env.SES_FROM_EMAIL = "notifications@example.invalid";
  process.env.APP_URL = "http://localhost:3000";
  Object.assign(process.env, { NODE_ENV: "test" });
  const { query, transaction, getPool } =
    await import("../src/server/db/index");
  try {
    for (const name of [
      "001_accounts.sql",
      "002_pipeline.sql",
      "003_email_notifications.sql",
      "004_email_daily_limit.sql",
      "005_subscriber_accounts.sql",
      "006_map_subscriptions.sql",
      "007_account_deletion.sql",
    ])
      await query(
        await readFile(resolve(process.cwd(), `migrations/${name}`), "utf8"),
      );
    await query(
      "UPDATE metro_email_state SET launch_cutoff=now()-interval '5 minutes'",
    );
    for (const [id, role, verified, enabled] of [
      ["alice", "collaborator", true, true],
      ["bob", "collaborator", true, true],
      ["admin", "admin", true, true],
      ["unverified", "collaborator", false, true],
      ["optedout", "collaborator", true, false],
      ["inactive", "collaborator", true, true],
    ] as const) {
      await query(
        `INSERT INTO "user"(id,name,email,"emailVerified","updatedAt") VALUES($1,$1,$2,$3,now()-interval '1 hour')`,
        [id, `${id}@example.invalid`, verified],
      );
      await query(
        "INSERT INTO metro_profiles(user_id,role,active) VALUES($1,$2,$3)",
        [id, role, id !== "inactive"],
      );
      await query(
        "INSERT INTO metro_email_preferences(user_id,enabled,consent_version,consent_at) VALUES($1,$2,1,now()-interval '1 hour')",
        [id, enabled],
      );
    }
    const operation = async (input: {
      kind?: string;
      actor?: string;
      payload: Record<string, unknown>;
      result?: Record<string, unknown>;
      status?: string;
      old?: boolean;
      repo?: string;
    }) => {
      const id = randomUUID();
      await query(
        `INSERT INTO metro_operations(id,kind,scope,idempotency_key,request_digest,actor_id,status,payload,result,checkpoint,updated_at)
      VALUES($1::uuid,$2,'email-test',$1::text,'test',$3,$4,$5,$6,$7,now()-CASE WHEN $8 THEN interval '1 day' ELSE interval '0' END)`,
        [
          id,
          input.kind || "comment",
          input.actor || null,
          input.status || "succeeded",
          JSON.stringify(input.payload),
          JSON.stringify(input.result || {}),
          JSON.stringify({ repository: input.repo || "local/test" }),
          input.old || false,
        ],
      );
      return id;
    };
    await operation({
      actor: "alice",
      payload: { issueNumber: 10, mentions: [] },
      result: { commentId: 123 },
      old: true,
    });
    const reply = await operation({
      actor: "bob",
      payload: {
        issueNumber: 10,
        replyToCommentId: 123,
        mentions: [{ userId: "alice" }],
        gameName: "Bob",
        comment: "4321",
      },
    });
    const general = await operation({
      kind: "request",
      actor: "alice",
      payload: { kind: "general", mentions: [{ userId: "bob" }] },
      result: { number: 11 },
    });
    const line = await operation({
      kind: "request",
      actor: "alice",
      payload: { kind: "line-update", operation: "add", notifyAdmins: true },
      result: { number: 12 },
    });
    await operation({
      actor: "alice",
      payload: { issueNumber: 10, mentions: [{ userId: "alice" }] },
    });
    await operation({
      actor: "bob",
      payload: { issueNumber: 10, mentions: [{ userId: "alice" }] },
      status: "failed",
    });
    await operation({
      actor: "bob",
      payload: { issueNumber: 10, mentions: [{ userId: "alice" }] },
      old: true,
    });
    await operation({
      actor: "bob",
      payload: { issueNumber: 10, replyToCommentId: 123, mentions: [] },
      repo: "different/repo",
    });
    await operation({
      payload: {
        issueNumber: 10,
        mentions: [
          { userId: "unverified" },
          { userId: "optedout" },
          { userId: "inactive" },
        ],
      },
    });
    const { enqueueOperationEmails, executeEmailJob, repairEmailJobs } =
      await import("../src/server/email/jobs");
    const { listNotifications } =
      await import("../src/server/operations/notifications");
    assert.equal(
      await transaction((client) => enqueueOperationEmails(client)),
      3,
    );
    assert.equal(
      await transaction((client) => enqueueOperationEmails(client)),
      0,
      "repair deduplicates operation/recipient",
    );
    const pending = await query<{
      id: string;
      operation_id: string;
      user_id: string;
      payload: { notificationKind: string; source: { comment?: string } };
    }>("SELECT id,operation_id,user_id,payload FROM metro_email_jobs");
    assert.equal(pending.rows.length, 3);
    assert.equal(
      pending.rows.find((row) => row.operation_id === reply)?.payload
        .notificationKind,
      "reply",
      "reply wins over simultaneous mention",
    );
    assert.equal(
      pending.rows.find((row) => row.operation_id === reply)?.payload.source
        .comment,
      "4321",
      "queued payload preserves the submitted comment for email rendering",
    );
    assert.equal(
      pending.rows.find((row) => row.operation_id === general)?.user_id,
      "bob",
    );
    assert.equal(
      pending.rows.find((row) => row.operation_id === line)?.payload
        .notificationKind,
      "line-add",
    );
    for (const item of pending.rows) {
      const inbox = await listNotifications(item.user_id);
      assert.equal(
        inbox.notifications.find((row) => row.id === item.operation_id)?.kind,
        item.payload.notificationKind,
        "sender matches inbox",
      );
    }
    const completion = await operation({
      actor: "bob",
      payload: { issueNumber: 10, mentions: [{ userId: "alice" }] },
      status: "accepted",
    });
    const lease = randomUUID();
    await query("UPDATE metro_operations SET lease_token=$2 WHERE id=$1", [
      completion,
      lease,
    ]);
    await query("INSERT INTO metro_outbox(operation_id) VALUES($1)", [
      completion,
    ]);
    const { finishOperation } = await import("../src/server/operations/store");
    await finishOperation(completion, lease, "succeeded", {});
    assert.equal(
      (
        await query("SELECT id FROM metro_email_jobs WHERE operation_id=$1", [
          completion,
        ])
      ).rowCount,
      1,
      "operation completion creates durable email and outbox work",
    );
    const interrupted = await operation({
      actor: "bob",
      payload: { issueNumber: 10, mentions: [{ userId: "alice" }] },
      status: "accepted",
    });
    const interruptedLease = randomUUID();
    await query("UPDATE metro_operations SET lease_token=$2 WHERE id=$1", [
      interrupted,
      interruptedLease,
    ]);
    await query("INSERT INTO metro_outbox(operation_id) VALUES($1)", [
      interrupted,
    ]);
    await query(`CREATE FUNCTION reject_fixture_email() RETURNS trigger LANGUAGE plpgsql AS
      $$ BEGIN RAISE EXCEPTION 'fixture_email_unavailable'; END $$;
      CREATE TRIGGER fixture_email_failure BEFORE INSERT ON metro_email_jobs
      FOR EACH ROW EXECUTE FUNCTION reject_fixture_email()`);
    await finishOperation(interrupted, interruptedLease, "succeeded", {});
    assert.equal(
      (
        await query<{ status: string }>(
          "SELECT status FROM metro_operations WHERE id=$1",
          [interrupted],
        )
      ).rows[0].status,
      "succeeded",
      "email persistence failure cannot roll back the website operation",
    );
    assert.equal(
      (
        await query("SELECT id FROM metro_email_jobs WHERE operation_id=$1", [
          interrupted,
        ])
      ).rowCount,
      0,
    );
    await query(
      "DROP TRIGGER fixture_email_failure ON metro_email_jobs; DROP FUNCTION reject_fixture_email()",
    );
    assert.equal(
      await transaction((client) => enqueueOperationEmails(client)),
      1,
      "repair recovers work after email persistence returns",
    );
    await query('UPDATE "user" SET email=$2 WHERE id=$1', [
      "alice",
      "replacement@example.invalid",
    ]);
    await query(
      "UPDATE metro_email_preferences SET enabled=false,consent_version=2 WHERE user_id=$1",
      ["bob"],
    );
    await query(
      "INSERT INTO metro_email_suppressions(address,reason,feedback_message_id) VALUES('admin@example.invalid','complaint','fixture')",
    );
    process.env.EMAIL_NOTIFICATIONS_ENABLED = "true";
    for (const row of pending.rows) {
      await Promise.all([executeEmailJob(row.id), executeEmailJob(row.id)]);
      const result = (
        await query<{ status: string; error_code: string; attempts: number }>(
          "SELECT status,error_code,attempts FROM metro_email_jobs WHERE id=$1",
          [row.id],
        )
      ).rows[0];
      assert.equal(result.status, "skipped");
      assert.equal(
        result.attempts,
        1,
        "concurrent workers acquire a single claim",
      );
      assert.equal(
        result.error_code,
        {
          alice: "address_changed",
          bob: "consent_changed",
          admin: "address_suppressed",
        }[row.user_id],
      );
    }
    process.env.EMAIL_NOTIFICATIONS_ENABLED = "false";
    await query(
      "UPDATE metro_email_jobs SET status='sending',lease_until=now()-interval '1 minute' WHERE operation_id=$1",
      [completion],
    );
    assert.equal((await repairEmailJobs()).uncertain, 1);
    assert.equal(
      (
        await query<{ status: string }>(
          "SELECT status FROM metro_email_jobs WHERE operation_id=$1",
          [completion],
        )
      ).rows[0].status,
      "outcome_unknown",
      "expired send claims never resend blindly",
    );
    console.log(
      JSON.stringify(
        {
          migration: "passed",
          recipientParity: "passed",
          replyPrecedence: "passed",
          cutoffAndConsent: "passed",
          idempotency: "passed",
          operationCompletion: "passed",
          enqueueFailureRecovery: "passed",
          concurrentClaims: "passed",
          queuedRechecks: "passed",
          crashRecovery: "passed",
          externalSends: 0,
        },
        null,
        2,
      ),
    );
  } finally {
    await getPool().end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
