import "server-only";
import { verify, X509Certificate } from "node:crypto";
import { z } from "zod";
import { transaction } from "../db";
import { AppError, errorResponse, json } from "../http";

const envelopeSchema = z.object({
  Type: z.enum([
    "Notification",
    "SubscriptionConfirmation",
    "UnsubscribeConfirmation",
  ]),
  MessageId: z.string().min(1).max(256),
  TopicArn: z.string().min(1).max(512),
  Message: z
    .string()
    .min(1)
    .max(256 * 1024),
  Timestamp: z.string().datetime({ offset: true }),
  SignatureVersion: z.enum(["1", "2"]),
  Signature: z
    .string()
    .min(1)
    .max(2048)
    .regex(/^[A-Za-z0-9+/]+={0,2}$/),
  SigningCertURL: z.string().max(2048),
  Subject: z.string().max(1024).optional(),
  SubscribeURL: z.string().max(8192).optional(),
  Token: z.string().min(1).max(4096).optional(),
});
export type SnsEnvelope = z.infer<typeof envelopeSchema>;
export type EmailFeedback = {
  sesMessageId: string | null;
  kind: string;
  addresses: string[];
  suppression: "permanent_bounce" | "complaint" | null;
};
const certificates = new Map<
  string,
  { certificate: X509Certificate; expires: number }
>();

/** Creates a safe SNS feedback rejection error.
 * Webhook parsing and signature checks use it.
 */
function invalid(code = "invalid_email_feedback", status = 400): AppError {
  return new AppError(code, "The email feedback request was rejected.", status);
}

/** Derives the allowed SNS host from the configured topic.
 * SNS URL validation uses it to prevent untrusted fetches.
 */
function snsHostname(topic: string): string {
  const match =
    /^arn:(aws|aws-cn|aws-us-gov):sns:([a-z]{2}(?:-[a-z]+)+-\d):\d{12}:[A-Za-z0-9_-]+$/.exec(
      topic,
    );
  if (!match) throw invalid("email_feedback_configuration", 503);
  return `sns.${match[2]}.amazonaws.com${match[1] === "aws-cn" ? ".cn" : ""}`;
}

/** Checks that an SNS URL stays on the expected HTTPS host.
 * Certificate and subscription URL validators call it.
 */
function trustedUrl(value: string, topic: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalid("invalid_sns_url");
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== snsHostname(topic) ||
    url.username ||
    url.password ||
    url.port ||
    url.hash ||
    // Reject explicit ports (including :443, normalized away by URL).
    !value.startsWith(`https://${url.hostname}/`)
  )
    throw invalid("invalid_sns_url");
  return url;
}

/** Restricts the SNS signing certificate URL shape.
 * Envelope verification calls it before fetching the certificate.
 */
export function validateSigningCertUrl(value: string, topic: string): URL {
  const url = trustedUrl(value, topic);
  if (
    url.search ||
    !/^\/SimpleNotificationService-[A-Za-z0-9_-]+\.pem$/.test(url.pathname)
  )
    throw invalid("invalid_sns_certificate_url");
  return url;
}

/** Checks every parameter in an SNS subscription URL.
 * The feedback webhook calls it before confirming the topic.
 */
export function validateConfirmationUrl(envelope: SnsEnvelope): URL {
  if (!envelope.SubscribeURL || !envelope.Token) throw invalid();
  const url = trustedUrl(envelope.SubscribeURL, envelope.TopicArn);
  const expected: Record<string, string> = {
    Action: "ConfirmSubscription",
    TopicArn: envelope.TopicArn,
    Token: envelope.Token,
  };
  if (url.pathname !== "/") throw invalid("invalid_sns_confirmation_url");
  for (const [key, value] of Object.entries(expected)) {
    if (
      url.searchParams.getAll(key).length !== 1 ||
      url.searchParams.get(key) !== value
    )
      throw invalid("invalid_sns_confirmation_url");
  }
  for (const [key, value] of url.searchParams) {
    if (!(key in expected) && !(key === "Version" && value === "2010-03-31"))
      throw invalid("invalid_sns_confirmation_url");
  }
  return url;
}

/** Builds the canonical SNS message bytes for signature checks.
 * Envelope verification uses it for Notification and confirmation events.
 */
export function snsSigningString(envelope: SnsEnvelope): string {
  const fields: (keyof SnsEnvelope)[] =
    envelope.Type === "Notification"
      ? [
          "Message",
          "MessageId",
          ...(envelope.Subject === undefined ? [] : ["Subject" as const]),
          "Timestamp",
          "TopicArn",
          "Type",
        ]
      : [
          "Message",
          "MessageId",
          "SubscribeURL",
          "Timestamp",
          "Token",
          "TopicArn",
          "Type",
        ];
  return fields
    .map((field) => {
      const value = envelope[field];
      if (value === undefined) throw invalid();
      return `${field}\n${value}\n`;
    })
    .join("");
}

/** Reads a stream within a byte limit as strict UTF-8.
 * The webhook and certificate fetch use it for untrusted bodies.
 */
async function boundedText(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<string> {
  if (!body) throw invalid();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      total += item.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw invalid("payload_too_large", 413);
      }
      chunks.push(item.value);
    }
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(
        Buffer.concat(chunks),
      );
    } catch {
      throw invalid("invalid_utf8");
    }
  } finally {
    reader.releaseLock();
  }
}

/** Validates the topic, certificate, and SNS signature.
 * The email feedback webhook calls it before trusting any event.
 */
export async function verifySnsEnvelope(
  payload: unknown,
  expectedTopic: string,
  fetcher: typeof fetch = fetch,
): Promise<SnsEnvelope> {
  const parsed = envelopeSchema.safeParse(payload);
  if (!parsed.success) throw invalid();
  const envelope = parsed.data;
  if (envelope.TopicArn !== expectedTopic)
    throw invalid("unexpected_sns_topic", 403);
  const url = validateSigningCertUrl(envelope.SigningCertURL, expectedTopic);
  const signingString = snsSigningString(envelope);
  const cached = certificates.get(url.href);
  let certificate =
    cached && cached.expires > Date.now() ? cached.certificate : undefined;
  if (!certificate) {
    let response: Response;
    try {
      response = await fetcher(url, {
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw invalid("sns_certificate_unavailable", 503);
    }
    if (!response.ok) throw invalid("sns_certificate_unavailable", 503);
    const pem = await boundedText(response.body, 32 * 1024);
    try {
      certificate = new X509Certificate(pem);
    } catch {
      throw invalid("invalid_sns_certificate");
    }
    // HTTPS authenticates the certificate's origin; the URL cannot redirect.
    const expiry = Date.parse(certificate.validTo);
    if (Date.parse(certificate.validFrom) > Date.now() || expiry <= Date.now())
      throw invalid("expired_sns_certificate", 403);
    if (certificates.size >= 8)
      certificates.delete(certificates.keys().next().value!);
    certificates.set(url.href, {
      certificate,
      expires: Math.min(expiry, Date.now() + 3_600_000),
    });
  }
  if (
    certificate.publicKey.asymmetricKeyType !== "rsa" ||
    !verify(
      envelope.SignatureVersion === "1" ? "RSA-SHA1" : "RSA-SHA256",
      Buffer.from(signingString, "utf8"),
      certificate.publicKey,
      Buffer.from(envelope.Signature, "base64"),
    )
  )
    throw invalid("invalid_sns_signature", 403);
  return envelope;
}

const recipientSchema = z.object({ emailAddress: z.string().email().max(320) });
const addressesSchema = z.array(recipientSchema).min(1).max(1000);
const mailSchema = z.object({ messageId: z.string().min(1).max(256) });

/** Classifies SES delivery, bounce, and complaint payloads.
 * Verified SNS notifications pass through it before persistence.
 */
export function parseSesFeedback(message: string): EmailFeedback {
  let payload: unknown;
  try {
    payload = JSON.parse(message);
  } catch {
    throw invalid();
  }
  const base = z
    .object({
      notificationType: z.string().optional(),
      eventType: z.string().optional(),
      mail: mailSchema,
    })
    .safeParse(payload);
  if (!base.success) throw invalid();
  const kind = base.data.notificationType ?? base.data.eventType;
  const result: EmailFeedback = {
    sesMessageId: base.data.mail.messageId,
    kind: "",
    addresses: [],
    suppression: null,
  };
  if (kind === "Bounce") {
    const parsed = z
      .object({
        bounce: z.object({
          bounceType: z.enum(["Permanent", "Transient", "Undetermined"]),
          bouncedRecipients: addressesSchema,
        }),
      })
      .safeParse(payload);
    if (!parsed.success) throw invalid();
    result.kind = `bounce_${parsed.data.bounce.bounceType.toLowerCase()}`;
    result.addresses = parsed.data.bounce.bouncedRecipients.map(
      (r) => r.emailAddress,
    );
    if (parsed.data.bounce.bounceType === "Permanent")
      result.suppression = "permanent_bounce";
  } else if (kind === "Complaint") {
    const parsed = z
      .object({
        complaint: z.object({ complainedRecipients: addressesSchema }),
      })
      .safeParse(payload);
    if (!parsed.success) throw invalid();
    result.kind = "complaint";
    result.suppression = "complaint";
    result.addresses = parsed.data.complaint.complainedRecipients.map(
      (r) => r.emailAddress,
    );
  } else if (kind === "Delivery") {
    const parsed = z
      .object({
        delivery: z.object({
          recipients: z.array(z.string().email().max(320)).min(1).max(1000),
        }),
      })
      .safeParse(payload);
    if (!parsed.success) throw invalid();
    result.kind = "delivery";
    result.addresses = parsed.data.delivery.recipients;
  } else if (
    kind &&
    [
      "Send",
      "Reject",
      "Open",
      "Click",
      "Rendering Failure",
      "RenderingFailure",
      "DeliveryDelay",
      "Subscription",
    ].includes(kind)
  ) {
    result.kind = `ignored_${kind.toLowerCase().replaceAll(" ", "_")}`;
  } else throw invalid("unsupported_ses_event");
  result.addresses = [
    ...new Set(result.addresses.map((address) => address.trim().toLowerCase())),
  ];
  return result;
}

/** Receipts remain joinable by SES ID even when feedback arrives before send persistence.
 * The feedback webhook calls it after SNS verification.
 */
export async function persistEmailFeedback(
  envelope: SnsEnvelope,
  event: EmailFeedback,
): Promise<boolean> {
  return transaction(async (client) => {
    const inserted = await client.query(
      `INSERT INTO metro_email_feedback(topic_arn,message_id,ses_message_id,event_kind,affected_addresses)
       VALUES ($1,$2,$3,$4,$5::jsonb) ON CONFLICT (topic_arn,message_id) DO NOTHING RETURNING message_id`,
      [
        envelope.TopicArn,
        envelope.MessageId,
        event.sesMessageId,
        event.kind,
        JSON.stringify(event.addresses),
      ],
    );
    if (!inserted.rowCount) return false;
    if (event.suppression) {
      // Sender holds the same lock from its final suppression check through SES
      // submission. Sort multi-recipient feedback to give every caller one order.
      const addresses = [...event.addresses].sort();
      for (const address of addresses) {
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
          `email-address:${address}`,
        ]);
      }
      for (const address of addresses) {
        await client.query(
          `INSERT INTO metro_email_suppressions(address,reason,feedback_message_id)
           VALUES ($1,$2,$3) ON CONFLICT (address) DO UPDATE
           SET reason = CASE WHEN metro_email_suppressions.reason = 'complaint' THEN 'complaint' ELSE EXCLUDED.reason END,
               feedback_message_id = CASE WHEN metro_email_suppressions.reason = 'complaint' THEN metro_email_suppressions.feedback_message_id ELSE EXCLUDED.feedback_message_id END`,
          [address, event.suppression, envelope.MessageId],
        );
      }
    }
    return true;
  });
}

/** Handles SNS subscription and SES feedback HTTP requests.
 * The feedback API route delegates its POST workflow here.
 */
export async function postEmailFeedback(request: Request): Promise<Response> {
  try {
    const topic = process.env.SES_FEEDBACK_TOPIC_ARN;
    if (!topic) throw invalid("email_feedback_configuration", 503);
    const contentType = request.headers
      .get("content-type")
      ?.split(";")[0]
      .trim()
      .toLowerCase();
    if (contentType !== "application/json" && contentType !== "text/plain")
      throw invalid("unsupported_media_type", 415);
    const maxBytes = 320 * 1024;
    if (Number(request.headers.get("content-length")) > maxBytes)
      throw invalid("payload_too_large", 413);
    let payload: unknown;
    const body = await boundedText(request.body, maxBytes);
    try {
      payload = JSON.parse(body);
    } catch {
      throw invalid("invalid_json");
    }
    const envelope = await verifySnsEnvelope(payload, topic);
    if (envelope.Type === "Notification") {
      await persistEmailFeedback(envelope, parseSesFeedback(envelope.Message));
    } else {
      if (envelope.Type === "SubscriptionConfirmation") {
        const url = validateConfirmationUrl(envelope);
        let response: Response;
        try {
          response = await fetch(url, {
            redirect: "error",
            signal: AbortSignal.timeout(10_000),
          });
        } catch {
          throw invalid("sns_confirmation_unavailable", 503);
        }
        // ConfirmSubscription is idempotent; retry is safe if local receipt commit failed.
        await response.body?.cancel();
        if (!response.ok) throw invalid("sns_confirmation_unavailable", 503);
      }
      await persistEmailFeedback(envelope, {
        sesMessageId: null,
        kind:
          envelope.Type === "SubscriptionConfirmation"
            ? "subscription_confirmed"
            : "subscription_unsubscribed",
        addresses: [],
        suppression: null,
      });
    }
    return json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}
