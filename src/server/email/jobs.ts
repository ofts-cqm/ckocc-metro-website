import "server-only";
import { randomUUID } from "node:crypto";
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import type { PoolClient } from "pg";
import { query, transaction } from "@/server/db";
import {
  notificationKindSql,
  notificationRecipientWhere,
} from "@/server/operations/notifications";
import { emailConfig, emailEnabled } from "./config";
import { emailLocale, renderEmail } from "./templates";
import { createUnsubscribeToken, tokenDigest, tokenValue } from "./tokens";
import { reserveNotificationSlot } from "./quota";

export interface EmailJob {
  id: string;
  operation_id: string | null;
  user_id: string | null;
  kind: "notification" | "verification";
  address: string;
  consent_version: number | null;
  token_id: string | null;
  locale: string;
  payload: Record<string, unknown>;
  status: string;
  attempts: number;
  lease_token: string | null;
}

export async function enqueueVerification(
  client: PoolClient,
  input: {
    userId: string;
    address: string;
    tokenId: string;
    locale: string;
  },
): Promise<void> {
  const id = randomUUID();
  await client.query(
    `INSERT INTO metro_email_jobs(id,user_id,kind,address,token_id,locale)
     VALUES($1,$2,'verification',$3,$4,$5)`,
    [
      id,
      input.userId,
      input.address.toLowerCase(),
      input.tokenId,
      emailLocale(input.locale),
    ],
  );
  await client.query("INSERT INTO metro_email_outbox(job_id) VALUES($1)", [id]);
}

/** The inbox and email evaluate the same predicate and reply-before-mention precedence. */
export async function enqueueOperationEmails(
  client: PoolClient,
  operationId?: string,
) {
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO metro_email_jobs(id,operation_id,user_id,kind,address,consent_version,locale,payload)
     SELECT gen_random_uuid(),o.id,u.id,'notification',lower(u.email),p.consent_version,p.locale,
       jsonb_build_object('notificationKind',${notificationKindSql("u.id")},
         'sender',o.payload->>'gameName','source',o.payload,'issueNumber',
         CASE WHEN o.kind='request' THEN o.result->>'number' ELSE o.payload->>'issueNumber' END)
     FROM metro_operations o CROSS JOIN metro_email_state launch
     JOIN "user" u ON true JOIN metro_profiles profile ON profile.user_id=u.id
     JOIN metro_email_preferences p ON p.user_id=u.id
     WHERE ${notificationRecipientWhere("u.id")}
       AND ($1::uuid IS NULL OR o.id=$1) AND o.updated_at>=launch.launch_cutoff
       AND profile.active AND profile.role IN ('collaborator','admin') AND u."emailVerified" AND p.enabled
       AND p.consent_at IS NOT NULL AND p.consent_at<=o.updated_at
       AND u."updatedAt"<=o.updated_at
     ON CONFLICT(operation_id,user_id) DO NOTHING RETURNING id`,
    [operationId ?? null],
  );
  if (inserted.rows.length)
    await client.query(
      "INSERT INTO metro_email_outbox(job_id) SELECT unnest($1::uuid[]) ON CONFLICT DO NOTHING",
      [inserted.rows.map((row) => row.id)],
    );
  return inserted.rows.length;
}

/** Drain one bounded recipient page per durable publication event. Snapshot the
 * account cursor, then recheck consent and address at delivery as for discussion mail. */
export async function enqueuePublicationEmails(client: PoolClient) {
  const events = await client.query<{
    id: string;
    recipient_cursor: string | null;
  }>(`SELECT id,recipient_cursor FROM metro_map_publication_events
      WHERE NOT recipients_complete ORDER BY published_at,id LIMIT 5 FOR UPDATE SKIP LOCKED`);
  let count = 0;
  for (const event of events.rows) {
    const recipients = await client.query<{ id: string }>(
      `SELECT u.id FROM "user" u
       JOIN metro_profiles profile ON profile.user_id=u.id
       JOIN metro_email_preferences p ON p.user_id=u.id
       JOIN metro_map_publication_events e ON e.id=$1
       WHERE ($2::text IS NULL OR u.id>$2) AND profile.active AND u."emailVerified"
         AND p.map_updates AND p.map_consent_at<=e.published_at
         AND u."updatedAt"<=e.published_at ORDER BY u.id LIMIT 250`,
      [event.id, event.recipient_cursor],
    );
    if (recipients.rows.length) {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO metro_email_jobs(id,publication_event_id,user_id,kind,address,consent_version,locale,payload)
         SELECT gen_random_uuid(),e.id,u.id,'notification',lower(u.email),p.map_consent_version,p.locale,
           jsonb_build_object('notificationKind','map-update','summary',e.summary,'revision',e.revision)
         FROM "user" u JOIN metro_email_preferences p ON p.user_id=u.id
         JOIN metro_map_publication_events e ON e.id=$1 WHERE u.id=ANY($2::text[])
           AND p.map_updates AND p.map_consent_at<=e.published_at AND u."updatedAt"<=e.published_at
         ON CONFLICT(publication_event_id,user_id) DO NOTHING RETURNING id`,
        [event.id, recipients.rows.map((row) => row.id)],
      );
      if (inserted.rows.length)
        await client.query(
          "INSERT INTO metro_email_outbox(job_id) SELECT unnest($1::uuid[]) ON CONFLICT DO NOTHING",
          [inserted.rows.map((row) => row.id)],
        );
      count += inserted.rows.length;
    }
    await client.query(
      `UPDATE metro_map_publication_events SET recipient_cursor=COALESCE($2,recipient_cursor),
       recipients_complete=$3 WHERE id=$1`,
      [
        event.id,
        recipients.rows.at(-1)?.id ?? null,
        recipients.rows.length < 250,
      ],
    );
  }
  return count;
}

async function finish(
  client: PoolClient,
  job: EmailJob,
  status: string,
  error: string | null = null,
  messageId: string | null = null,
) {
  await client.query(
    `UPDATE metro_email_jobs SET status=$3,error_code=$4,ses_message_id=COALESCE($5,ses_message_id),
       lease_token=NULL,lease_until=NULL,updated_at=now() WHERE id=$1 AND lease_token=$2`,
    [job.id, job.lease_token, status, error, messageId],
  );
  await client.query(
    "UPDATE metro_email_outbox SET state='done',updated_at=now() WHERE job_id=$1",
    [job.id],
  );
}

export function classifySendFailure(error: unknown): {
  status: "pending" | "failed" | "outcome_unknown";
  code: string;
} {
  const value = error as {
    name?: string;
    $metadata?: { httpStatusCode?: number };
  };
  const name = value?.name;
  const status = value?.$metadata?.httpStatusCode;
  if (name === "CredentialsProviderError")
    return { status: "failed", code: "email_credentials_missing" };
  if (
    status === 429 ||
    name === "TooManyRequestsException" ||
    name === "LimitExceededException"
  )
    return { status: "pending", code: "ses_throttled" };
  if (status && status >= 400 && status < 500)
    return {
      status: "failed",
      code:
        status === 401 || status === 403 ? "ses_unauthorized" : "ses_rejected",
    };
  // A timeout, socket close, or 5xx can hide acceptance. SES has no idempotency token.
  return { status: "outcome_unknown", code: "ses_outcome_unknown" };
}

async function deliverySkipReason(
  client: PoolClient,
  job: EmailJob,
): Promise<string | null> {
  // Serialize account and preference changes with the final send check. The SDK has
  // a bounded request timeout; a process crash preserves the committed sending claim.
  const users = await client.query<{
    email: string;
    emailVerified: boolean;
    active: boolean;
    auth_version: number;
    role: string;
  }>(
    `SELECT u.email,u."emailVerified",profile.active,profile.auth_version,profile.role
         FROM "user" u JOIN metro_profiles profile ON profile.user_id=u.id
         WHERE u.id=$1 FOR SHARE OF u,profile`,
    [job.user_id],
  );
  const user = users.rows[0];
  let skip: string | null = !user?.active ? "account_inactive" : null;
  if (!skip && job.kind === "notification") {
    const preferences = await client.query<{
      enabled: boolean;
      consent_version: number;
      map_updates: boolean;
      map_consent_version: number;
    }>(
      "SELECT enabled,consent_version,map_updates,map_consent_version FROM metro_email_preferences WHERE user_id=$1 FOR SHARE",
      [job.user_id],
    );
    const preference = preferences.rows[0];
    const mapUpdate = job.payload.notificationKind === "map-update";
    if (!mapUpdate && user.role === "subscriber") skip = "role_changed";
    else if (user.email.toLowerCase() !== job.address) skip = "address_changed";
    else if (!user.emailVerified) skip = "address_unverified";
    else if (
      !(mapUpdate ? preference?.map_updates : preference?.enabled) ||
      (mapUpdate
        ? preference?.map_consent_version
        : preference?.consent_version) !== job.consent_version
    )
      skip = "consent_changed";
  }
  if (!skip && job.kind === "verification") {
    const tokens = await client.query<{
      purpose: string;
      source_email: string;
      auth_version: number;
    }>(
      `SELECT purpose,source_email,auth_version FROM metro_email_tokens
           WHERE id=$1 AND user_id=$2 AND address=$3 AND token_digest=$4
             AND consumed_at IS NULL AND expires_at>now() AND purpose IN ('verification','change') FOR SHARE`,
      [
        job.token_id,
        job.user_id,
        job.address,
        tokenDigest(tokenValue(job.token_id!)),
      ],
    );
    const token = tokens.rows[0];
    if (
      !token ||
      token.source_email !== user.email.toLowerCase() ||
      token.auth_version !== user.auth_version ||
      (token.purpose === "verification" &&
        (user.emailVerified || user.email.toLowerCase() !== job.address))
    )
      skip = "verification_expired";
  }
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
    `email-address:${job.address}`,
  ]);
  const suppressed = await client.query(
    "SELECT address FROM metro_email_suppressions WHERE address=$1",
    [job.address],
  );
  if (suppressed.rowCount) skip = "address_suppressed";
  return skip;
}

export async function executeEmailJob(
  id: string,
): Promise<{ retry: boolean; delay: number }> {
  if (!emailEnabled()) return { retry: false, delay: 0 };
  const config = emailConfig();
  const lease = randomUUID();
  const claimed = await query<EmailJob>(
    `UPDATE metro_email_jobs SET status='sending',attempts=attempts+1,lease_token=$2,
      lease_until=now()+interval '5 minutes',updated_at=now()
     WHERE id=$1 AND status='pending' AND next_attempt_at<=now() AND attempts<5 RETURNING *`,
    [id, lease],
  );
  const job = claimed.rows[0];
  if (!job) return { retry: false, delay: 0 };
  if (!job.user_id) {
    await transaction((client) =>
      finish(client, job, "skipped", "account_deleted"),
    );
    return { retry: false, delay: 0 };
  }
  const userId = job.user_id;
  let submissionStarted = false;
  let rejection: ReturnType<typeof classifySendFailure> | undefined;
  try {
    // Commit quota and scoped links before SES. A lost result must not reopen
    // quota or invalidate a link in a message that may already be delivered.
    const prepared = await transaction(async (client) => {
      const skip = await deliverySkipReason(client, job);
      if (skip) {
        await finish(client, job, "skipped", skip);
        return null;
      }
      const reservationTime = new Date();
      const quota =
        job.kind === "notification"
          ? await reserveNotificationSlot(
              client,
              { id: job.id, user_id: userId },
              reservationTime,
            )
          : { allowed: true, last: false };
      if (!quota.allowed) {
        await finish(client, job, "skipped", "daily_email_limit");
        return null;
      }
      const unsubscribeToken =
        job.kind === "notification"
          ? await createUnsubscribeToken(client, userId, job.address)
          : undefined;
      return {
        unsubscribeToken,
        dailyLimitReached: quota.last,
        quotaDay: reservationTime.toISOString().slice(0, 10),
      };
    });
    if (!prepared) return { retry: false, delay: 0 };
    return await transaction(async (client) => {
      const skip = await deliverySkipReason(client, job);
      if (skip) {
        await finish(client, job, "skipped", skip);
        return { retry: false, delay: 0 };
      }
      const content = renderEmail({
        kind: job.kind,
        locale: job.locale,
        origin: config.origin,
        payload: job.payload,
        token: job.token_id ? tokenValue(job.token_id) : undefined,
        unsubscribeToken: prepared.unsubscribeToken,
        dailyLimitReached: prepared.dailyLimitReached,
      });
      const ses = new SESv2Client({
        region: config.region,
        maxAttempts: 1,
        requestHandler: {
          connectionTimeout: 5_000,
          requestTimeout: 20_000,
          throwOnRequestTimeout: true,
        },
      });
      try {
        // A preflight delayed across UTC midnight must reserve the new day's
        // quota before submitting. No SES request has started, so retry is safe.
        if (
          job.kind === "notification" &&
          new Date().toISOString().slice(0, 10) !== prepared.quotaDay
        )
          throw new Error("email_quota_day_changed");
        submissionStarted = true;
        let response;
        try {
          response = await ses.send(
            new SendEmailCommand({
              FromEmailAddress: config.from,
              Destination: { ToAddresses: [job.address] },
              ...(config.replyTo ? { ReplyToAddresses: [config.replyTo] } : {}),
              Content: {
                Simple: {
                  Subject: { Data: content.subject, Charset: "UTF-8" },
                  Body: {
                    Text: { Data: content.text, Charset: "UTF-8" },
                    Html: { Data: content.html, Charset: "UTF-8" },
                  },
                },
              },
              EmailTags: [{ Name: "metro_job_id", Value: job.id }],
            }),
          );
        } catch (error) {
          rejection = classifySendFailure(error);
          throw error;
        }
        if (!response.MessageId) throw new Error("ses_missing_message_id");
        await finish(client, job, "submitted", null, response.MessageId);
        return { retry: false, delay: 0 };
      } finally {
        ses.destroy();
      }
    });
  } catch {
    const failure =
      rejection ??
      (submissionStarted
        ? { status: "outcome_unknown" as const, code: "ses_outcome_unknown" }
        : { status: "pending" as const, code: "email_preparation_failed" });
    const retry = failure.status === "pending" && job.attempts < 5;
    const status =
      failure.status === "pending" && !retry ? "failed" : failure.status;
    const delay = Math.min(3600, 60 * 2 ** (job.attempts - 1));
    await transaction(async (client) => {
      await client.query(
        `UPDATE metro_email_jobs SET status=$3,error_code=$4,lease_token=NULL,lease_until=NULL,
          next_attempt_at=now()+$5*interval '1 second',updated_at=now() WHERE id=$1 AND lease_token=$2`,
        [job.id, job.lease_token, status, failure.code, delay],
      );
      await client.query(
        `UPDATE metro_email_outbox SET state=$2,next_attempt_at=now()+$3*interval '1 second',updated_at=now() WHERE job_id=$1`,
        [job.id, retry ? "pending" : "done", delay],
      );
    });
    return { retry, delay };
  }
}

export async function launchPendingEmailJobs() {
  if (!emailEnabled()) return 0;
  const { start } = await import("workflow/api");
  const { emailWorkflow } = await import("@/workflows/email");
  const candidates = await query<{ job_id: string }>(
    `SELECT b.job_id FROM metro_email_outbox b JOIN metro_email_jobs j ON j.id=b.job_id
     WHERE b.state='pending' AND b.next_attempt_at<=now() AND j.status='pending' AND j.next_attempt_at<=now()
     ORDER BY b.updated_at LIMIT 25`,
  );
  let launched = 0;
  for (const row of candidates.rows) {
    const claimed = await query(
      `UPDATE metro_email_outbox SET state='launching',attempts=attempts+1,updated_at=now()
       WHERE job_id=$1 AND state='pending' RETURNING job_id`,
      [row.job_id],
    );
    if (!claimed.rowCount) continue;
    try {
      const run = await start(emailWorkflow, [row.job_id]);
      await query(
        "UPDATE metro_email_outbox SET state='started',run_id=$2,updated_at=now() WHERE job_id=$1 AND state='launching'",
        [row.job_id, run.runId],
      );
      launched++;
    } catch {
      await query(
        "UPDATE metro_email_outbox SET state='pending',next_attempt_at=now()+interval '1 minute',updated_at=now() WHERE job_id=$1 AND state='launching'",
        [row.job_id],
      );
    }
  }
  return launched;
}

/** Advance recipient pagination and launch pagination together so large lists do
 * not wait for the next cron tick. Jobs retain their own retry/outcome semantics. */
export async function drainPublicationEmailPage() {
  if (!emailEnabled()) return { remaining: false, progress: false };
  const discovered = await transaction(enqueuePublicationEmails);
  const launched = await launchPendingEmailJobs();
  const pending = await query<{ remaining: boolean }>(
    `SELECT EXISTS(SELECT 1 FROM metro_map_publication_events WHERE NOT recipients_complete)
       OR EXISTS(SELECT 1 FROM metro_email_outbox b JOIN metro_email_jobs j ON j.id=b.job_id
         WHERE b.state='pending' AND j.status='pending') AS remaining`,
  );
  return {
    remaining: pending.rows[0].remaining,
    progress: discovered > 0 || launched > 0,
  };
}

export async function launchPublicationEmailDrain() {
  if (!emailEnabled()) return;
  const { start } = await import("workflow/api");
  const { mapEmailWorkflow } = await import("@/workflows/map-emails");
  await start(mapEmailWorkflow, []);
}

export async function repairEmailJobs() {
  const discovered = await transaction(
    async (client) =>
      (await enqueueOperationEmails(client)) +
      (await enqueuePublicationEmails(client)),
  );
  // An abandoned sending lease may already have reached SES. Never reset it to pending.
  const uncertain = await query(
    `UPDATE metro_email_jobs SET status='outcome_unknown',error_code='sending_lease_expired',
     lease_token=NULL,lease_until=NULL,updated_at=now() WHERE status='sending' AND lease_until<now()`,
  );
  await query(`UPDATE metro_email_outbox b SET state='pending',updated_at=now()
    FROM metro_email_jobs j WHERE j.id=b.job_id AND j.status='pending'
    AND b.state IN ('launching','started') AND b.updated_at<now()-interval '10 minutes'`);
  const launched = await launchPendingEmailJobs();
  const { sendPendingSubscriberInvitations } =
    await import("./subscriber-invitations");
  await sendPendingSubscriberInvitations();
  await launchPublicationEmailDrain();
  return { discovered, launched, uncertain: uncertain.rowCount || 0 };
}
