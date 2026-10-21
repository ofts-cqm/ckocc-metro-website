/** Explicit development-only live SES/SNS acceptance test. No GitHub writes. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { getPool, query, transaction } from "../src/server/db/pool";
import {
  enqueueOperationEmails,
  executeEmailJob,
} from "../src/server/email/jobs";

async function main() {
  const database = new URL(process.env.DATABASE_URL || "");
  assert(
    ["localhost", "127.0.0.1", "[::1]"].includes(database.hostname),
    "Simulator tests require a loopback development database.",
  );
  assert(
    process.env.EMAIL_SIMULATOR_TEST === "true",
    "Set EMAIL_SIMULATOR_TEST=true to explicitly enable simulator sends.",
  );
  assert(
    process.env.EMAIL_NOTIFICATIONS_ENABLED === "true",
    "Email sending must be enabled for this test.",
  );
  const run = randomUUID();
  const fixtures: {
    userId: string;
    operationId: string;
    jobId: string;
    address: string;
    scenario: string;
  }[] = [];
  for (const scenario of ["success", "bounce", "complaint"]) {
    const userId = `email-simulator-${run}-${scenario}`;
    const operationId = randomUUID();
    const address = `${scenario}@simulator.amazonses.com`;
    const prior = await query(
      "SELECT 1 FROM metro_email_suppressions WHERE address=$1",
      [address],
    );
    assert.equal(
      prior.rowCount,
      0,
      `${scenario} is already locally suppressed; use a fresh test database for another live run.`,
    );
    const jobId = await transaction(async (client) => {
      await client.query(
        'INSERT INTO "user"(id,name,email,"emailVerified") VALUES($1,$2,$3,true)',
        [userId, `Simulator ${scenario}`, address],
      );
      await client.query(
        "INSERT INTO metro_profiles(user_id,role) VALUES($1,'collaborator')",
        [userId],
      );
      await client.query(
        "INSERT INTO metro_email_preferences(user_id,enabled,consent_version,consent_at) VALUES($1,true,1,now())",
        [userId],
      );
      await client.query(
        `INSERT INTO metro_operations(id,kind,scope,idempotency_key,request_digest,status,payload,result)
        VALUES($1::uuid,'request',$2,$1::text,'simulator','succeeded',$3,$4)`,
        [
          operationId,
          `email-simulator:${run}`,
          JSON.stringify({
            kind: "general",
            gameName: "Email simulator test",
            mentions: [{ userId }],
          }),
          JSON.stringify({ number: 1 }),
        ],
      );
      assert.equal(await enqueueOperationEmails(client, operationId), 1);
      assert.equal(
        await enqueueOperationEmails(client, operationId),
        0,
        "Enqueue must deduplicate",
      );
      const jobs = await client.query(
        "SELECT id FROM metro_email_jobs WHERE operation_id=$1",
        [operationId],
      );
      return jobs.rows[0].id as string;
    });
    fixtures.push({ userId, operationId, jobId, address, scenario });
    await executeEmailJob(jobId);
    const sent = await query(
      "SELECT status,error_code,ses_message_id FROM metro_email_jobs WHERE id=$1",
      [jobId],
    );
    assert.equal(
      sent.rows[0].status,
      "submitted",
      JSON.stringify(sent.rows[0]),
    );
    assert(sent.rows[0].ses_message_id);
    console.log(
      JSON.stringify({
        scenario,
        jobId,
        status: "submitted",
        sesMessageId: sent.rows[0].ses_message_id,
      }),
    );
  }
  const deadline = Date.now() + 120_000;
  let received = false;
  while (Date.now() < deadline) {
    const suppressed = await query(
      "SELECT address FROM metro_email_suppressions WHERE address=ANY($1::text[])",
      [fixtures.filter((f) => f.scenario !== "success").map((f) => f.address)],
    );
    if (suppressed.rowCount === 2) {
      received = true;
      break;
    }
    console.log("Waiting for signed SNS bounce and complaint feedback…");
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  assert(
    received,
    "Timed out waiting for real SNS bounce and complaint suppression. Inspect tunnel and SNS subscription.",
  );
  for (const fixture of fixtures.filter((f) => f.scenario !== "success")) {
    const receipts = await query(
      `SELECT f.event_kind FROM metro_email_feedback f JOIN metro_email_jobs j ON j.ses_message_id=f.ses_message_id WHERE j.id=$1`,
      [fixture.jobId],
    );
    assert(
      receipts.rowCount! > 0,
      "Feedback must correlate with submitted SES ID",
    );
    const operationId = randomUUID();
    const jobId = await transaction(async (client) => {
      await client.query(
        `INSERT INTO metro_operations(id,kind,scope,idempotency_key,request_digest,status,payload,result)
        VALUES($1::uuid,'request',$2,$1::text,'simulator','succeeded',$3,'{"number":1}')`,
        [
          operationId,
          `email-simulator:${run}`,
          JSON.stringify({
            kind: "general",
            gameName: "Suppression check",
            mentions: [{ userId: fixture.userId }],
          }),
        ],
      );
      await enqueueOperationEmails(client, operationId);
      return (
        await client.query(
          "SELECT id FROM metro_email_jobs WHERE operation_id=$1",
          [operationId],
        )
      ).rows[0].id;
    });
    await executeEmailJob(jobId);
    const skipped = (
      await query(
        "SELECT status,error_code,ses_message_id FROM metro_email_jobs WHERE id=$1",
        [jobId],
      )
    ).rows[0];
    assert.equal(skipped.status, "skipped");
    assert.equal(skipped.error_code, "address_suppressed");
    assert.equal(skipped.ses_message_id, null);
    console.log(
      JSON.stringify({
        scenario: fixture.scenario,
        feedback: receipts.rows,
        suppression: "confirmed",
        subsequentSend: "skipped",
      }),
    );
  }
  console.log(
    `PASS live SES → SNS → local database. Fixture run: ${run}. Records retained for review.`,
  );
}
main()
  .catch((error) => {
    console.error(
      error instanceof Error ? error.message : "Simulator test failed",
    );
    process.exitCode = 1;
  })
  .finally(() => getPool().end());
