/** Real PostgreSQL checks in a disposable schema; never sends mail or changes app tables. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { Client } from "pg";
import { mock } from "node:test";
let externalAttempts = 0;
let mockSendFails = false;
mock.module("@aws-sdk/client-sesv2", {
  namedExports: {
    SESv2Client: class {
      async send() {
        externalAttempts++;
        if (mockSendFails) throw new Error("simulated timeout");
        return { MessageId: "local-test-message" };
      }
      destroy() {}
    },
    SendEmailCommand: class {
      constructor(public input: unknown) {}
    },
  },
});

async function main() {
  const database =
    process.env.EMAIL_TEST_DATABASE_URL || process.env.DATABASE_URL;
  if (!database) throw new Error("A local test DATABASE_URL is required.");
  const url = new URL(database);
  if (
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    !/(test|dev)/i.test(url.pathname)
  )
    throw new Error("Subscriber checks require a local test/dev database.");
  const schema = `subscriber_test_${randomUUID().replaceAll("-", "")}`;
  const control = new Client({ connectionString: database });
  await control.connect();
  await control.query(`CREATE SCHEMA ${schema}`);
  url.searchParams.set("options", `-c search_path=${schema}`);
  process.env.DATABASE_URL = url.toString();
  process.env.BETTER_AUTH_SECRET =
    "subscriber-local-test-secret-at-least-32-characters";
  process.env.EMAIL_TOKEN_SECRET =
    "subscriber-local-email-secret-at-least-32-characters";
  process.env.EMAIL_NOTIFICATIONS_ENABLED = "false";
  const { query, transaction, getPool } =
    await import("../src/server/db/index");
  try {
    for (const file of (await readdir("migrations"))
      .filter((f) => /^\d+.*\.sql$/.test(f))
      .sort())
      await query(await readFile(`migrations/${file}`, "utf8"));
    const { requestSubscription, redeemInvitation } =
      await import("../src/server/auth/invitations");
    const { subscriberInvitationToken } =
      await import("../src/server/email/subscriber-invitations");
    const { emailSettings, setEmailPreferences } =
      await import("../src/server/email/accounts");
    const { enqueuePublicationEmails } =
      await import("../src/server/email/jobs");
    const input = {
      email: "subscriber@example.invalid",
      displayName: "Subscriber",
      locale: "en-US" as const,
      challenge: "test",
      idempotencyKey: randomUUID(),
    };
    await Promise.all(
      Array.from({ length: 4 }, () => requestSubscription(input)),
    );
    const invitations = await query<{ id: string }>(
      "SELECT id FROM metro_invitations",
    );
    assert.equal(
      invitations.rowCount,
      1,
      "concurrent subscription requests share one invitation",
    );
    assert.equal(
      (await query("SELECT * FROM metro_subscription_mail")).rowCount,
      1,
    );
    // Exercise the real claim/status SQL while the provider is mocked.
    const { sendSubscriberInvitation } =
      await import("../src/server/email/subscriber-invitations");
    process.env.EMAIL_NOTIFICATIONS_ENABLED = "true";
    process.env.APP_URL = "https://metro.example.invalid";
    process.env.AWS_REGION = "us-east-1";
    process.env.SES_FROM_EMAIL = "test@example.invalid";
    await requestSubscription({
      ...input,
      email: "second@example.invalid",
      displayName: "Second",
    });
    const second = (
      await query<{ id: string }>(
        "SELECT id FROM metro_invitations WHERE email='second@example.invalid'",
      )
    ).rows[0].id;
    assert.equal(
      await sendSubscriberInvitation(invitations.rows[0].id),
      "sent",
    );
    assert.equal(externalAttempts, 1, "request sends only its own invitation");
    assert.equal(
      (
        await query<{ status: string }>(
          "SELECT status FROM metro_subscription_mail WHERE invitation_id=$1",
          [second],
        )
      ).rows[0].status,
      "pending",
    );
    assert.equal(
      await sendSubscriberInvitation(invitations.rows[0].id),
      "sent",
    );
    assert.equal(externalAttempts, 1, "repeated request does not resend");
    mockSendFails = true;
    assert.equal(await sendSubscriberInvitation(second), "outcome_unknown");
    assert.equal(await sendSubscriberInvitation(second), "outcome_unknown");
    assert.equal(externalAttempts, 2, "unknown delivery cannot be resent");
    process.env.EMAIL_NOTIFICATIONS_ENABLED = "false";
    // A pre-activation event must never be backfilled.
    await query(
      "INSERT INTO metro_map_publication_events(repository,commit_sha,revision,summary,published_at) VALUES('test','old','old','Old',clock_timestamp()-interval '1 minute')",
    );
    const token = subscriberInvitationToken(invitations.rows[0].id);
    const results = await Promise.allSettled(
      Array.from({ length: 2 }, () =>
        redeemInvitation({ token, password: "subscriber test password" }),
      ),
    );
    assert.equal(
      results.filter((r) => r.status === "fulfilled").length,
      1,
      "one redemption wins",
    );
    const user = (
      await query<{ id: string; role: string }>(
        `SELECT u.id,p.role FROM "user" u JOIN metro_profiles p ON p.user_id=u.id`,
      )
    ).rows[0];
    assert.equal(user.role, "subscriber");
    const preferences = await emailSettings(user.id);
    assert.equal(preferences.verified, true);
    assert.equal(preferences.mapUpdates, true);
    assert.equal(preferences.enabled, false);
    await query(
      "INSERT INTO metro_map_publication_events(repository,commit_sha,revision,summary,published_at) VALUES('test','new','new','New',clock_timestamp())",
    );
    assert.equal(await transaction(enqueuePublicationEmails), 1);
    assert.equal(
      await transaction(enqueuePublicationEmails),
      0,
      "recipient jobs deduplicate",
    );
    const jobs = await query<{ notificationKind: string }>(
      `SELECT payload->>'notificationKind' AS "notificationKind" FROM metro_email_jobs`,
    );
    assert.equal(jobs.rows[0].notificationKind, "map-update");
    await setEmailPreferences(user.id, {
      enabled: true,
      mapUpdates: false,
      locale: "en-us",
    });
    assert.equal(
      (await emailSettings(user.id)).enabled,
      false,
      "subscriber cannot enable discussion mail",
    );
    await query(
      "INSERT INTO metro_map_publication_events(repository,commit_sha,revision,summary,published_at) VALUES('test','later','later','Later',clock_timestamp())",
    );
    assert.equal(
      await transaction(enqueuePublicationEmails),
      0,
      "opt-out excludes future events",
    );
    const { deleteAccount } = await import("../src/server/auth/delete-account");
    const { createCredentialAccount } =
      await import("../src/server/auth/credentials");
    const { verifiedAuthor } =
      await import("../src/server/operations/attribution");
    const adminId = await transaction((client) =>
      createCredentialAccount(client, {
        email: "admin@example.invalid",
        name: "Admin",
        role: "admin",
        passwordHash: "test-only",
      }),
    );
    const { createPasswordReset } =
      await import("../src/server/auth/invitations");
    const resetLink = await createPasswordReset(adminId, user.id, "en-US");
    const resetToken = new URL(resetLink.url).searchParams.get("token")!;
    const { createUnsubscribeToken } =
      await import("../src/server/email/tokens");
    const { consumeEmailToken } = await import("../src/server/email/accounts");
    const oldUnsubscribe = await transaction((client) =>
      createUnsubscribeToken(client, user.id, input.email),
    );
    const completedId = randomUUID(),
      queuedId = randomUUID(),
      unknownJob = randomUUID(),
      editId = randomUUID(),
      uploadId = randomUUID();
    await query(
      `INSERT INTO "session"(id,token,"expiresAt","userId") VALUES($1,$1,now()+interval '1 day',$2)`,
      [randomUUID(), user.id],
    );
    await query(
      `INSERT INTO metro_edit_sessions(id,owner_id,base_commit,base_revision,expires_at) VALUES($1,$2,'base','revision',now()+interval '1 day')`,
      [editId, user.id],
    );
    await query(
      `INSERT INTO metro_uploads(id,edit_session_id,owner_id,kind,pathname,reserved_bytes,expires_at) VALUES($1,$2,$3,'json',$4,100,now()+interval '1 day')`,
      [uploadId, editId, user.id, `test-only/${uploadId}`],
    );
    for (const [id, status, role] of [
      [completedId, "succeeded", "collaborator"],
      [queuedId, "accepted", "subscriber"],
    ]) {
      await query(
        `INSERT INTO metro_operations(id,kind,scope,idempotency_key,request_digest,actor_id,status,payload,checkpoint)
        VALUES($1::uuid,'comment',($1::uuid)::text,'key','digest',$2,$3,'{"gameName":"Subscriber"}',jsonb_build_object('authorRole',$4::text))`,
        [id, user.id, status, role],
      );
      await query("INSERT INTO metro_outbox(operation_id) VALUES($1)", [id]);
    }
    await query(
      `INSERT INTO metro_email_jobs(id,user_id,kind,address,locale,status) VALUES($1,$2,'notification','subscriber@example.invalid','en-us','outcome_unknown')`,
      [unknownJob, user.id],
    );
    await query(
      `INSERT INTO metro_email_daily_slots(job_id,user_id,quota_day,position) VALUES($1,$2,CURRENT_DATE,1)`,
      [unknownJob, user.id],
    );
    await query(
      `INSERT INTO metro_email_suppressions(address,reason,feedback_message_id) VALUES('subscriber@example.invalid','complaint','fixture')`,
    );
    await query(
      "UPDATE metro_operations SET status='outcome_unknown' WHERE id=$1",
      [queuedId],
    );
    await assert.rejects(deleteAccount(adminId, user.id), {
      code: "account_delete_busy",
    });
    assert.equal(
      (await query('SELECT id FROM "user" WHERE id=$1', [user.id])).rowCount,
      1,
    );
    await query("UPDATE metro_operations SET status='accepted' WHERE id=$1", [
      queuedId,
    ]);
    const beforeDeletion = (
      await query<{ updated_at: Date }>(
        "SELECT updated_at FROM metro_operations WHERE id=$1",
        [completedId],
      )
    ).rows[0].updated_at;
    await deleteAccount(adminId, user.id);
    await deleteAccount(adminId, user.id);
    assert.equal(
      (await query('SELECT id FROM "user" WHERE id=$1', [user.id])).rowCount,
      0,
    );
    for (const table of ["account", "session"])
      assert.equal(
        (await query(`SELECT * FROM "${table}" WHERE "userId"=$1`, [user.id]))
          .rowCount,
        0,
      );
    assert.equal(
      (
        await query("SELECT * FROM metro_email_preferences WHERE user_id=$1", [
          user.id,
        ])
      ).rowCount,
      0,
    );
    const history = (
      await query<{
        actor_id: string | null;
        checkpoint: Record<string, unknown>;
        updated_at: Date;
      }>(
        "SELECT actor_id,checkpoint,updated_at FROM metro_operations WHERE id=$1",
        [completedId],
      )
    ).rows[0];
    assert.equal(history.actor_id, null);
    assert.equal(verifiedAuthor(history), true);
    assert.equal(
      history.updated_at.toISOString(),
      beforeDeletion.toISOString(),
      "deletion cannot backfill historical notifications",
    );
    assert.equal(
      (
        await query<{ status: string }>(
          "SELECT status FROM metro_operations WHERE id=$1",
          [queuedId],
        )
      ).rows[0].status,
      "failed",
    );
    assert.equal(
      (
        await query<{ owner_id: string | null }>(
          "SELECT owner_id FROM metro_uploads WHERE id=$1",
          [uploadId],
        )
      ).rows[0].owner_id,
      null,
    );
    const retained = (
      await query<{ user_id: string | null; status: string }>(
        "SELECT user_id,status FROM metro_email_jobs WHERE id=$1",
        [unknownJob],
      )
    ).rows[0];
    assert.equal(retained.user_id, null);
    assert.equal(retained.status, "outcome_unknown");
    assert.equal(
      (
        await query("SELECT * FROM metro_email_daily_slots WHERE job_id=$1", [
          unknownJob,
        ])
      ).rowCount,
      1,
    );
    assert.equal(
      (
        await query(
          "SELECT * FROM metro_email_suppressions WHERE address='subscriber@example.invalid'",
        )
      ).rowCount,
      1,
    );
    const replacement = await requestSubscription(input);
    assert.notEqual(
      replacement,
      invitations.rows[0].id,
      "email is reusable without reviving old credentials or invitations",
    );
    await assert.rejects(
      redeemInvitation({ token, password: "new password" }),
      { code: "invalid_invitation" },
    );
    await assert.rejects(
      redeemInvitation({ token: resetToken, password: "new password" }),
      { code: "invalid_invitation" },
    );
    await redeemInvitation({
      token: subscriberInvitationToken(replacement),
      password: "replacement password",
    });
    const replacementUser = (
      await query<{ id: string }>(`SELECT id FROM "user" WHERE email=$1`, [
        input.email,
      ])
    ).rows[0];
    assert.notEqual(
      replacementUser.id,
      user.id,
      "fresh registration must never regain the deleted identity",
    );
    await assert.rejects(consumeEmailToken(oldUnsubscribe, "unsubscribe"), {
      code: "invalid_link",
    });
    console.log(
      "PASS: all migrations, concurrent subscriber issuance/redemption, verified activation and consent, publication cutoff, recipient deduplication, guest email scope, map opt-out, targeted provider acceptance, persistent send uncertainty, safe permanent deletion and email reuse; mocked provider only, zero external sends.",
    );
  } finally {
    await getPool().end();
    await control.query(`DROP SCHEMA ${schema} CASCADE`);
    await control.end();
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
