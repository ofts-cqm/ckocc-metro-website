/** Isolated PostgreSQL acceptance test; never sends email or modifies the app schema. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Client } from "pg";

async function main() {
  const database =
    process.env.EMAIL_TEST_DATABASE_URL || process.env.DATABASE_URL;
  if (!database) throw new Error("A local test DATABASE_URL is required.");
  const parsed = new URL(database);
  if (
    !["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname) ||
    !/(test|dev)/i.test(parsed.pathname)
  )
    throw new Error(
      "Email account tests require a local database named test or dev.",
    );
  const schema = `email_accounts_${randomUUID().replaceAll("-", "")}`;
  const control = new Client({ connectionString: database });
  await control.connect();
  await control.query(`CREATE SCHEMA ${schema}`);
  parsed.searchParams.set("options", `-c search_path=${schema}`);
  process.env.DATABASE_URL = parsed.toString();
  process.env.BETTER_AUTH_SECRET =
    "email-accounts-test-secret-32-characters-minimum";
  process.env.ABUSE_HASH_SECRET =
    "email-accounts-abuse-secret-32-characters-minimum";
  process.env.DISABLE_RATE_LIMITS = "true";
  Object.assign(process.env, { NODE_ENV: "test" });
  process.env.EMAIL_NOTIFICATIONS_ENABLED = "false";
  const { getPool, query, transaction } =
    await import("../src/server/db/index");
  try {
    for (const migration of [
      "001_accounts.sql",
      "002_pipeline.sql",
      "003_email_notifications.sql",
      "004_email_daily_limit.sql",
    ])
      await query(
        await readFile(`${process.cwd()}/migrations/${migration}`, "utf8"),
      );
    const { createCredentialAccount, revokeUserSessions } =
      await import("../src/server/auth/credentials");
    const { hashPassword } = await import("../src/server/auth/password");
    const {
      requestEmailVerification,
      consumeEmailToken,
      emailSettings,
      setEmailPreferences,
    } = await import("../src/server/email/accounts");
    const { tokenValue, createUnsubscribeToken } =
      await import("../src/server/email/tokens");
    const password = "metro account acceptance";
    const userId = await transaction((client) =>
      createCredentialAccount(client, {
        email: "first@example.invalid",
        name: "Email Tester",
        role: "collaborator",
        passwordHash: "temporary",
      }),
    );
    await query('UPDATE "account" SET password=$1 WHERE "userId"=$2', [
      await hashPassword(password),
      userId,
    ]);
    const request = new Request("http://localhost/api/email/verification");
    const latestToken = async () =>
      tokenValue(
        (
          await query<{ id: string }>(
            "SELECT id FROM metro_email_tokens WHERE user_id=$1 AND purpose IN ('verification','change') AND consumed_at IS NULL ORDER BY created_at DESC LIMIT 1",
            [userId],
          )
        ).rows[0].id,
      );
    const failure = (error: unknown) =>
      !!error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "invalid_link";
    assert.equal((await emailSettings(userId)).enabled, false);
    await requestEmailVerification(request, userId, { locale: "en-us" });
    const first = await latestToken();
    assert.equal(
      (await emailSettings(userId)).verified,
      false,
      "GET/settings and issuance cannot verify",
    );
    await assert.rejects(
      consumeEmailToken(first, "unsubscribe"),
      failure,
      "verification token cannot unsubscribe",
    );
    await query(
      "UPDATE metro_email_tokens SET expires_at=now()-interval '1 second' WHERE user_id=$1",
      [userId],
    );
    await assert.rejects(consumeEmailToken(first, "verify"), failure);
    await requestEmailVerification(request, userId, { locale: "en-us" });
    const valid = await latestToken();
    const simultaneous = await Promise.allSettled([
      consumeEmailToken(valid, "verify"),
      consumeEmailToken(valid, "verify"),
    ]);
    assert.equal(
      simultaneous.filter((result) => result.status === "fulfilled").length,
      1,
      "exactly one concurrent consumer wins",
    );
    assert.equal((await emailSettings(userId)).verified, true);
    assert.equal(
      (await emailSettings(userId)).enabled,
      false,
      "verification is not consent",
    );
    await setEmailPreferences(userId, { enabled: true, locale: "zh-hk" });
    const beforeVersion = (
      await query<{ consent_version: number }>(
        "SELECT consent_version FROM metro_email_preferences WHERE user_id=$1",
        [userId],
      )
    ).rows[0].consent_version;
    const oldUnsubscribe = await transaction((client) =>
      createUnsubscribeToken(client, userId, "first@example.invalid"),
    );
    await assert.rejects(
      requestEmailVerification(request, userId, {
        locale: "en-us",
        address: "second@example.invalid",
        password: "wrong-password",
      }),
      /current password/,
    );
    await requestEmailVerification(request, userId, {
      locale: "en-us",
      address: "second@example.invalid",
      password,
    });
    let pending = await latestToken();
    assert.equal((await emailSettings(userId)).email, "first@example.invalid");
    assert.equal(
      (await emailSettings(userId)).pendingAddress,
      "second@example.invalid",
    );
    await transaction((client) => revokeUserSessions(client, userId));
    await assert.rejects(
      consumeEmailToken(pending, "verify"),
      failure,
      "password reset/session revocation invalidates change links",
    );
    await requestEmailVerification(request, userId, {
      locale: "en-us",
      address: "second@example.invalid",
      password,
    });
    pending = await latestToken();
    await query(
      'INSERT INTO "session" (id,token,"expiresAt","userId","authVersion") VALUES ($1,$2,now()+interval \'1 day\',$3,2)',
      [randomUUID(), randomUUID(), userId],
    );
    assert.deepEqual(await consumeEmailToken(pending, "verify"), {
      changed: true,
    });
    assert.equal((await emailSettings(userId)).email, "second@example.invalid");
    assert.equal((await emailSettings(userId)).verified, true);
    assert.equal(
      Number(
        (
          await query<{ count: string }>(
            'SELECT count(*) FROM "session" WHERE "userId"=$1',
            [userId],
          )
        ).rows[0].count,
      ),
      0,
    );
    assert.equal(
      (
        await query<{ consent_version: number }>(
          "SELECT consent_version FROM metro_email_preferences WHERE user_id=$1",
          [userId],
        )
      ).rows[0].consent_version,
      beforeVersion + 1,
    );
    await assert.rejects(
      consumeEmailToken(oldUnsubscribe, "unsubscribe"),
      failure,
      "old mailbox cannot disable replacement mailbox",
    );
    const unsubscribe = await transaction((client) =>
      createUnsubscribeToken(client, userId, "second@example.invalid"),
    );
    await assert.rejects(
      consumeEmailToken(unsubscribe, "verify"),
      failure,
      "unsubscribe token cannot change identity",
    );
    await consumeEmailToken(unsubscribe, "unsubscribe");
    assert.equal((await emailSettings(userId)).enabled, false);
    await assert.rejects(
      consumeEmailToken(unsubscribe, "unsubscribe"),
      failure,
    );
    await query(
      "INSERT INTO metro_email_suppressions(address,reason,feedback_message_id) VALUES ('suppressed@example.invalid','complaint','test-feedback')",
    );
    await assert.rejects(
      requestEmailVerification(request, userId, {
        locale: "en-us",
        address: "suppressed@example.invalid",
        password,
      }),
      /suppressed/,
    );
    await setEmailPreferences(userId, { enabled: true, locale: "en-us" });
    assert.equal(
      (await query("SELECT address FROM metro_email_suppressions")).rowCount,
      1,
      "consent does not clear suppression",
    );
    console.log(
      "PASS: migration, default consent, expiry, scoped tokens, concurrent consumption, password validation, auth-version races, address replacement, session revocation, stale unsubscribe, suppression persistence.",
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
