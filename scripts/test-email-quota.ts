/** Isolated PostgreSQL acceptance through the real worker; SES is always mocked. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { mock } from "node:test";
import { Client } from "pg";

type Message = {
  Destination: { ToAddresses: string[] };
  Content: {
    Simple: { Body: { Text: { Data: string }; Html: { Data: string } } };
  };
  EmailTags: { Name: string; Value: string }[];
};
const sent: Message[] = [];
const failures = new Map<string, unknown>();
mock.module("@aws-sdk/client-sesv2", {
  namedExports: {
    SESv2Client: class {
      async send(command: { input: Message }) {
        sent.push(command.input);
        const jobId = command.input.EmailTags[0].Value;
        if (failures.has(jobId)) throw failures.get(jobId);
        return { MessageId: `mock-${randomUUID()}` };
      }
      destroy() {}
    },
    SendEmailCommand: class {
      constructor(public input: Message) {}
    },
  },
});

async function main() {
  const connection =
    process.env.EMAIL_TEST_DATABASE_URL || process.env.DATABASE_URL;
  if (!connection) throw new Error("A local test database is required.");
  const url = new URL(connection);
  if (
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    !/(test|dev)/i.test(url.pathname)
  )
    throw new Error("Email quota tests require a local test/dev database.");
  const schema = `email_quota_${randomUUID().replaceAll("-", "")}`;
  const admin = new Client({ connectionString: connection });
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${schema}`);
  url.searchParams.set("options", `-c search_path=${schema}`);
  process.env.DATABASE_URL = url.toString();
  process.env.EMAIL_NOTIFICATIONS_ENABLED = "true";
  delete process.env.EMAIL_NOTIFICATIONS_PER_DAY;
  process.env.EMAIL_TOKEN_SECRET =
    "isolated-email-quota-secret-with-over-32-characters";
  process.env.AWS_REGION = "us-east-1";
  process.env.SES_FROM_EMAIL = "notifications@example.invalid";
  process.env.APP_URL = "http://localhost:3000";
  Object.assign(process.env, { NODE_ENV: "test" });
  const { query, transaction, getPool } =
    await import("../src/server/db/index");
  const { executeEmailJob } = await import("../src/server/email/jobs");
  const { reserveNotificationSlot } = await import("../src/server/email/quota");
  const { tokenValue, tokenDigest } =
    await import("../src/server/email/tokens");
  const migrate = async (name: string) =>
    query(await readFile(`${process.cwd()}/migrations/${name}`, "utf8"));
  const user = async (id: string, role = "collaborator") => {
    await query(
      'INSERT INTO "user"(id,name,email,"emailVerified") VALUES($1,$1,$2,true)',
      [id, `${id}@example.invalid`],
    );
    await query("INSERT INTO metro_profiles(user_id,role) VALUES($1,$2)", [
      id,
      role,
    ]);
    await query(
      "INSERT INTO metro_email_preferences(user_id,enabled,consent_version,consent_at) VALUES($1,true,1,now())",
      [id],
    );
  };
  const job = async (userId: string, status = "pending") => {
    const id = randomUUID();
    await query(
      `INSERT INTO metro_email_jobs(id,user_id,kind,address,consent_version,payload,status)
      VALUES($1,$2,'notification',$3,1,$4,$5)`,
      [
        id,
        userId,
        `${userId}@example.invalid`,
        JSON.stringify({
          notificationKind: "reply",
          sender: "Bob",
          issueNumber: 1,
          source: { comment: "4321" },
        }),
        status,
      ],
    );
    await query("INSERT INTO metro_email_outbox(job_id) VALUES($1)", [id]);
    return id;
  };
  const state = async (id: string) =>
    (
      await query<{ status: string; error_code: string; attempts: number }>(
        "SELECT status,error_code,attempts FROM metro_email_jobs WHERE id=$1",
        [id],
      )
    ).rows[0];
  const slots = async (userId: string) =>
    Number(
      (
        await query<{ count: string }>(
          "SELECT count(*) FROM metro_email_daily_slots WHERE user_id=$1",
          [userId],
        )
      ).rows[0].count,
    );
  const notices = (messages: Message[]) =>
    messages.filter((message) =>
      message.Content.Simple.Body.Text.Data.includes(
        "you won’t receive any more notification emails today",
      ),
    );
  try {
    for (const name of [
      "001_accounts.sql",
      "002_pipeline.sql",
      "003_email_notifications.sql",
    ])
      await migrate(name);
    await user("existing");
    for (const status of [
      "submitted",
      "sending",
      "outcome_unknown",
      "skipped",
      "failed",
    ])
      await job("existing", status);
    await migrate("004_email_daily_limit.sql");
    assert.equal(
      await slots("existing"),
      3,
      "migration counts previously submitted and uncertain sends, but excludes failed/skipped jobs",
    );
    const existing = await Promise.all(
      Array.from({ length: 3 }, () => job("existing")),
    );
    await Promise.all(existing.map(executeEmailJob));
    assert.equal(
      sent.length,
      2,
      "migration backfill leaves only two slots today",
    );
    assert.equal(notices(sent).length, 1);

    await user("concurrent");
    const concurrent = await Promise.all(
      Array.from({ length: 7 }, () => job("concurrent")),
    );
    const start = sent.length;
    await Promise.all(
      concurrent.flatMap((id) => [executeEmailJob(id), executeEmailJob(id)]),
    );
    const batch = sent.slice(start);
    assert.equal(
      batch.length,
      5,
      "concurrent jobs and duplicate workers respect default cap",
    );
    assert.equal(await slots("concurrent"), 5);
    assert.equal(
      notices(batch).length,
      1,
      "only the fifth reserved notification includes the limit notice",
    );
    for (const message of batch) {
      assert.match(message.Content.Simple.Body.Text.Data, /\n4321\n/);
      assert.match(message.Content.Simple.Body.Html.Data, />4321<\/div>/);
    }
    assert.match(
      notices(batch)[0].Content.Simple.Body.Html.Data,
      /notifications=open/,
    );
    const results = await Promise.all(concurrent.map(state));
    assert.equal(results.filter((row) => row.status === "submitted").length, 5);
    assert.equal(
      results.filter(
        (row) =>
          row.status === "skipped" && row.error_code === "daily_email_limit",
      ).length,
      2,
    );
    assert.ok(
      results.every((row) => row.attempts === 1),
      "each job is claimed once",
    );
    assert.equal(
      (
        await query(
          "SELECT job_id FROM metro_email_outbox WHERE state<>'done' AND job_id=ANY($1::uuid[])",
          [concurrent],
        )
      ).rowCount,
      0,
      "excess mail is terminal and has no deferred backlog",
    );

    await user("independent", "admin");
    const independent = await job("independent");
    await executeEmailJob(independent);
    assert.equal(
      (await state(independent)).status,
      "submitted",
      "another administrator has independent quota",
    );
    assert.equal(await slots("independent"), 1);

    process.env.EMAIL_NOTIFICATIONS_PER_DAY = "2";
    await user("override");
    const override = await Promise.all(
      Array.from({ length: 3 }, () => job("override")),
    );
    const overrideStart = sent.length;
    for (const id of override) await executeEmailJob(id);
    assert.equal(sent.length - overrideStart, 2);
    assert.equal(notices(sent.slice(overrideStart)).length, 1);
    assert.equal((await state(override[2])).error_code, "daily_email_limit");

    await query('UPDATE "user" SET email=$2 WHERE id=$1', [
      "override",
      "replacement@example.invalid",
    ]);
    await query(
      "UPDATE metro_email_preferences SET consent_version=3 WHERE user_id='override'",
    );
    const changed = await job("override");
    await query(
      "UPDATE metro_email_jobs SET address='replacement@example.invalid',consent_version=3 WHERE id=$1",
      [changed],
    );
    await executeEmailJob(changed);
    assert.equal(
      (await state(changed)).error_code,
      "daily_email_limit",
      "address and opt-in changes do not reset account quota",
    );

    await user("days");
    const days = await Promise.all(
      Array.from({ length: 3 }, () => job("days")),
    );
    const reserve = (id: string, date: string) =>
      transaction((client) =>
        reserveNotificationSlot(
          client,
          { id, user_id: "days" },
          new Date(date),
        ),
      );
    assert.deepEqual(await reserve(days[0], "2040-01-01T23:59:59Z"), {
      allowed: true,
      last: false,
    });
    assert.deepEqual(await reserve(days[1], "2040-01-01T23:59:59Z"), {
      allowed: true,
      last: true,
    });
    assert.deepEqual(await reserve(days[2], "2040-01-01T23:59:59Z"), {
      allowed: false,
      last: false,
    });
    assert.deepEqual(
      await reserve(days[2], "2040-01-02T00:00:00Z"),
      { allowed: true, last: false },
      "quota resets at midnight UTC",
    );

    process.env.EMAIL_NOTIFICATIONS_PER_DAY = "1";
    await user("retry");
    const retry = await job("retry");
    failures.set(retry, {
      name: "TooManyRequestsException",
      $metadata: { httpStatusCode: 429 },
    });
    assert.equal((await executeEmailJob(retry)).retry, true);
    assert.equal(
      await slots("retry"),
      1,
      "confirmed failure retains its reservation",
    );
    await query(
      "UPDATE metro_email_jobs SET next_attempt_at=now() WHERE id=$1",
      [retry],
    );
    failures.delete(retry);
    await executeEmailJob(retry);
    assert.equal((await state(retry)).status, "submitted");
    assert.equal(await slots("retry"), 1, "same-day retry reuses the slot");
    const afterRetry = await job("retry");
    await executeEmailJob(afterRetry);
    assert.equal((await state(afterRetry)).error_code, "daily_email_limit");

    await user("uncertain");
    const uncertain = await job("uncertain");
    failures.set(uncertain, new Error("socket closed"));
    await executeEmailJob(uncertain);
    assert.equal((await state(uncertain)).status, "outcome_unknown");
    assert.equal(
      await slots("uncertain"),
      1,
      "ambiguous failure retains committed reservation",
    );
    const afterUncertain = await job("uncertain");
    await executeEmailJob(afterUncertain);
    assert.equal((await state(afterUncertain)).error_code, "daily_email_limit");

    for (const [id, change, code] of [
      [
        "optedout",
        "UPDATE metro_email_preferences SET enabled=false WHERE user_id=$1",
        "consent_changed",
      ],
      [
        "unverified",
        'UPDATE "user" SET "emailVerified"=false WHERE id=$1',
        "address_unverified",
      ],
      [
        "inactive",
        "UPDATE metro_profiles SET active=false WHERE user_id=$1",
        "account_inactive",
      ],
      [
        "suppressed",
        "INSERT INTO metro_email_suppressions(address,reason,feedback_message_id) VALUES($1 || '@example.invalid','complaint','fixture')",
        "address_suppressed",
      ],
    ]) {
      await user(id);
      const ineligible = await job(id);
      await query(change, [id]);
      await executeEmailJob(ineligible);
      assert.equal((await state(ineligible)).error_code, code);
      assert.equal(
        await slots(id),
        0,
        "ineligible work must not consume quota",
      );
    }

    const tokenId = randomUUID();
    const verificationId = randomUUID();
    await query(
      `INSERT INTO metro_email_tokens(id,user_id,purpose,address,source_email,auth_version,token_digest,expires_at)
      VALUES($1,'retry','change','new@example.invalid','retry@example.invalid',1,$2,now()+interval '1 hour')`,
      [tokenId, tokenDigest(tokenValue(tokenId))],
    );
    await query(
      "INSERT INTO metro_email_jobs(id,user_id,kind,address,token_id) VALUES($1,'retry','verification','new@example.invalid',$2)",
      [verificationId, tokenId],
    );
    await query("INSERT INTO metro_email_outbox(job_id) VALUES($1)", [
      verificationId,
    ]);
    const verificationStart = sent.length;
    await executeEmailJob(verificationId);
    assert.equal(
      (await state(verificationId)).status,
      "submitted",
      "verification is allowed after notification cap",
    );
    assert.equal(sent.length - verificationStart, 1);
    assert.equal(
      await slots("retry"),
      1,
      "verification consumes no notification quota",
    );
    assert.equal(notices(sent.slice(verificationStart)).length, 0);

    console.log(
      JSON.stringify(
        {
          migrationBackfill: "passed",
          concurrentHardCap: "passed",
          finalEmailNotice: "passed",
          contentSnapshot: "passed",
          independentAccounts: "passed",
          environmentOverride: "passed",
          utcReset: "passed",
          addressAndConsentPersistence: "passed",
          retryReservation: "passed",
          uncertainReservation: "passed",
          ineligibleSkips: "passed",
          verificationExcluded: "passed",
          mockedSendAttempts: sent.length,
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
    mock.restoreAll();
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
