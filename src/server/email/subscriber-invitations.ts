import "server-only";
import { createHmac } from "node:crypto";
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import { query, transaction } from "@/server/db";
import { emailConfig, emailEnabled } from "./config";

export function subscriberInvitationToken(id: string): string {
  const secret =
    process.env.EMAIL_TOKEN_SECRET || process.env.BETTER_AUTH_SECRET;
  if (!secret || secret.length < 32) throw new Error("email_not_configured");
  return createHmac("sha256", secret)
    .update(`metro-subscription:v1:${id}`)
    .digest("base64url");
}

/** Persisted intent precedes SES; ambiguous submissions are never automatically retried. */
export async function sendPendingSubscriberInvitations(
  invitationId?: string,
): Promise<void> {
  if (!emailEnabled()) return;
  const config = emailConfig();
  await query(`UPDATE metro_subscription_mail SET status='outcome_unknown',updated_at=now()
    WHERE status='sending' AND updated_at<now()-interval '5 minutes'`);
  const rows = await query<{
    invitation_id: string;
    email: string;
    locale: string;
  }>(
    `
    WITH candidates AS (SELECT invitation_id FROM metro_subscription_mail WHERE status='pending' AND ($1::uuid IS NULL OR invitation_id=$1) ORDER BY updated_at LIMIT 20 FOR UPDATE SKIP LOCKED)
    UPDATE metro_subscription_mail m SET status='sending',updated_at=now()
    FROM candidates c, metro_invitations i WHERE m.invitation_id=c.invitation_id AND i.id=m.invitation_id
    RETURNING m.invitation_id,i.email,i.locale`,
    [invitationId ?? null],
  );
  for (const job of rows.rows) {
    const link = new URL(`/${job.locale}/invite`, config.origin);
    link.searchParams.set(
      "token",
      subscriberInvitationToken(job.invitation_id),
    );
    const subject =
      job.locale === "zh-cn"
        ? "订阅地图更新"
        : job.locale === "zh-hk"
          ? "訂閱地圖更新"
          : "Subscribe to map updates";
    const body =
      job.locale === "zh-cn"
        ? "请打开以下链接并设置密码，以验证邮箱并订阅地图更新。链接24小时内有效。如果您未申请订阅，请忽略此邮件。"
        : job.locale === "zh-hk"
          ? "請開啟以下連結並設定密碼，以驗證電郵並訂閱地圖更新。連結24小時內有效。如果您未申請訂閱，請忽略此郵件。"
          : "Open this link and set a password to verify your email and subscribe to map updates. The link expires after 24 hours. If you did not request this, ignore this email.";
    const ses = new SESv2Client({
      region: config.region,
      maxAttempts: 1,
      requestHandler: {
        connectionTimeout: 5000,
        requestTimeout: 20000,
        throwOnRequestTimeout: true,
      },
    });
    let rejected = false;
    try {
      await transaction(async (client) => {
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
          `email-address:${job.email}`,
        ]);
        const eligible = await client.query(
          `SELECT 1 FROM metro_invitations i WHERE id=$1 AND expires_at>now() AND consumed_at IS NULL AND revoked_at IS NULL
           AND NOT EXISTS(SELECT 1 FROM metro_email_suppressions WHERE address=i.email)
           AND NOT EXISTS(SELECT 1 FROM "user" WHERE lower(email)=i.email)`,
          [job.invitation_id],
        );
        if (!eligible.rowCount) {
          await client.query(
            "UPDATE metro_subscription_mail SET status='skipped',updated_at=now() WHERE invitation_id=$1",
            [job.invitation_id],
          );
          return;
        }
        const response = await ses
          .send(
            new SendEmailCommand({
              FromEmailAddress: config.from,
              Destination: { ToAddresses: [job.email] },
              ...(config.replyTo ? { ReplyToAddresses: [config.replyTo] } : {}),
              Content: {
                Simple: {
                  Subject: {
                    Data: `CKOCC Metro — ${subject}`,
                    Charset: "UTF-8",
                  },
                  Body: {
                    Text: { Data: `${body}\n\n${link.href}`, Charset: "UTF-8" },
                  },
                },
              },
              EmailTags: [
                {
                  Name: "metro_subscription_invitation_id",
                  Value: job.invitation_id,
                },
              ],
            }),
          )
          .catch((error: unknown) => {
            // A definite SES 4xx rejection cannot have accepted this message. Network
            // failures and 5xx responses remain uncertain and must never be retried blindly.
            const status = (
              error as { $metadata?: { httpStatusCode?: number } }
            )?.$metadata?.httpStatusCode;
            rejected =
              typeof status === "number" && status >= 400 && status < 500;
            throw error;
          });
        if (!response.MessageId) throw new Error("missing_message_id");
        await client.query(
          "UPDATE metro_subscription_mail SET status='submitted',provider_message_id=$2,updated_at=now() WHERE invitation_id=$1",
          [job.invitation_id, response.MessageId],
        );
      });
    } catch {
      await query(
        rejected
          ? "UPDATE metro_subscription_mail SET status='skipped',updated_at=now() WHERE invitation_id=$1"
          : "UPDATE metro_subscription_mail SET status='outcome_unknown',updated_at=now() WHERE invitation_id=$1",
        [job.invitation_id],
      );
    } finally {
      ses.destroy();
    }
  }
}

/** Only persisted provider acceptance is a successful send. A repeated browser request
 * observes the existing job; it cannot resend submitted or uncertain invitations. */
export async function sendSubscriberInvitation(
  invitationId: string,
): Promise<"sent" | "pending" | "failed" | "outcome_unknown"> {
  await sendPendingSubscriberInvitations(invitationId);
  const result = await query<{
    status: string;
    provider_message_id: string | null;
  }>(
    "SELECT status,provider_message_id FROM metro_subscription_mail WHERE invitation_id=$1",
    [invitationId],
  );
  const job = result.rows[0];
  if (job?.status === "submitted" && job.provider_message_id) return "sent";
  if (job?.status === "pending" || job?.status === "sending") return "pending";
  if (job?.status === "skipped") return "failed";
  return "outcome_unknown";
}
