import assert from "node:assert/strict";
import { after, before, beforeEach, mock, test } from "node:test";
import { sign } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const topic = "arn:aws:sns:us-east-1:123456789012:email-feedback";
let receipts = new Map<string, unknown[]>();
let suppressed = new Map<string, { reason: string; messageId: string }>();
let failWrites = false;
let addressLocks: string[] = [];
mock.module("../src/server/db/index.ts", {
  namedExports: {
    transaction: async (run: (client: unknown) => Promise<unknown>) => {
      const previousReceipts = new Map(receipts);
      const previousSuppressed = new Map(suppressed);
      try {
        return await run({
          query: async (sql: string, params: unknown[]) => {
            if (sql.includes("pg_advisory_xact_lock")) {
              addressLocks.push(params[0] as string);
              return { rowCount: 1, rows: [] };
            }
            if (sql.includes("INSERT INTO metro_email_feedback")) {
              const key = `${params[0]}:${params[1]}`;
              if (receipts.has(key)) return { rowCount: 0, rows: [] };
              receipts.set(key, params);
              return { rowCount: 1, rows: [{ message_id: params[1] }] };
            }
            if (sql.includes("INSERT INTO metro_email_suppressions")) {
              if (failWrites)
                throw new Error("database temporarily unavailable");
              const [address, reason, messageId] = params as string[];
              if (suppressed.get(address)?.reason !== "complaint")
                suppressed.set(address, { reason, messageId });
              return { rowCount: 1, rows: [] };
            }
            throw new Error("Unexpected SQL in feedback test");
          },
        });
      } catch (error) {
        receipts = previousReceipts;
        suppressed = previousSuppressed;
        throw error;
      }
    },
  },
});
let feedback: typeof import("../src/server/email/feedback");
let key: string;
let certificate: string;
let certificateIndex = 0;
const originalFetch = globalThis.fetch;
const originalTopic = process.env.SES_FEEDBACK_TOPIC_ARN;
const temporary = mkdtempSync(join(tmpdir(), "metro-sns-test-"));

before(async () => {
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      join(temporary, "key.pem"),
      "-out",
      join(temporary, "cert.pem"),
      "-days",
      "1",
      "-subj",
      "/CN=sns.us-east-1.amazonaws.com",
    ],
    { stdio: "ignore" },
  );
  key = readFileSync(join(temporary, "key.pem"), "utf8");
  certificate = readFileSync(join(temporary, "cert.pem"), "utf8");
  feedback = await import("../src/server/email/feedback");
});

beforeEach(() => {
  receipts.clear();
  suppressed.clear();
  failWrites = false;
  addressLocks = [];
  process.env.SES_FEEDBACK_TOPIC_ARN = topic;
  globalThis.fetch = async () => new Response(certificate);
});
after(() => {
  globalThis.fetch = originalFetch;
  if (originalTopic === undefined) delete process.env.SES_FEEDBACK_TOPIC_ARN;
  else process.env.SES_FEEDBACK_TOPIC_ARN = originalTopic;
  rmSync(temporary, { recursive: true, force: true });
});

function ses(kind = "Bounce", bounceType = "Permanent") {
  return JSON.stringify({
    notificationType: kind,
    mail: {
      messageId: "ses-message-1",
      destination: ["unaffected@example.com"],
    },
    bounce: {
      bounceType,
      bouncedRecipients: [
        { emailAddress: "Old@Example.com" },
        { emailAddress: "another@example.com" },
      ],
    },
    complaint: { complainedRecipients: [{ emailAddress: "old@example.com" }] },
    delivery: { recipients: ["old@example.com"] },
    futureField: { ignored: true },
  });
}

function signed(
  values: Partial<import("../src/server/email/feedback").SnsEnvelope> = {},
): import("../src/server/email/feedback").SnsEnvelope {
  const envelope: import("../src/server/email/feedback").SnsEnvelope = {
    Type: "Notification",
    MessageId: "sns-message-1",
    TopicArn: topic,
    Message: ses(),
    Timestamp: new Date().toISOString(),
    SignatureVersion: "2",
    Signature: "placeholder",
    SigningCertURL: `https://sns.us-east-1.amazonaws.com/SimpleNotificationService-test${++certificateIndex}.pem`,
    ...values,
  };
  envelope.Signature = sign(
    envelope.SignatureVersion === "1" ? "RSA-SHA1" : "RSA-SHA256",
    Buffer.from(feedback.snsSigningString(envelope)),
    key,
  ).toString("base64");
  return envelope;
}

function request(payload: unknown, contentType = "text/plain; charset=UTF-8") {
  return new Request("http://localhost/api/email/feedback", {
    method: "POST",
    headers: { "content-type": contentType },
    body: JSON.stringify(payload),
  });
}

test("canonical SNS strings include the optional subject and trailing newline; both signature versions verify", async () => {
  for (const version of ["1", "2"] as const) {
    const envelope = signed({
      SignatureVersion: version,
      Subject: "SES event\nwith newline",
    });
    const canonical = feedback.snsSigningString(envelope);
    assert.ok(
      canonical.includes("Subject\nSES event\nwith newline\nTimestamp\n"),
    );
    assert.ok(canonical.endsWith("Type\nNotification\n"));
    assert.deepEqual(
      await feedback.verifySnsEnvelope(envelope, topic),
      envelope,
    );
    await assert.rejects(
      feedback.verifySnsEnvelope(
        { ...envelope, Message: ses("Complaint") },
        topic,
      ),
      { code: "invalid_sns_signature" },
    );
  }
});

test("forged signature and unexpected topic produce no writes; topic mismatch never fetches", async () => {
  const envelope = signed();
  const bad = await feedback.postEmailFeedback(
    request({ ...envelope, Signature: Buffer.alloc(256).toString("base64") }),
  );
  assert.equal(bad.status, 403);
  globalThis.fetch = async () => {
    throw new Error("Must not fetch");
  };
  const mismatch = await feedback.postEmailFeedback(
    request({ ...envelope, TopicArn: `${topic}-other` }),
  );
  assert.equal(mismatch.status, 403);
  assert.equal(receipts.size, 0);
  assert.equal(suppressed.size, 0);
});

test("certificate URL allowlist rejects SSRF, redirect hosts, alternate regions, ports, queries, and credentials", () => {
  for (const url of [
    "http://sns.us-east-1.amazonaws.com/SimpleNotificationService-test.pem",
    "https://localhost/SimpleNotificationService-test.pem",
    "https://169.254.169.254/SimpleNotificationService-test.pem",
    "https://sns.us-east-1.amazonaws.com.evil.test/SimpleNotificationService-test.pem",
    "https://sns.us-east-2.amazonaws.com/SimpleNotificationService-test.pem",
    "https://user@sns.us-east-1.amazonaws.com/SimpleNotificationService-test.pem",
    "https://sns.us-east-1.amazonaws.com:443/SimpleNotificationService-test.pem",
    "https://sns.us-east-1.amazonaws.com:8443/SimpleNotificationService-test.pem",
    "https://sns.us-east-1.amazonaws.com/SimpleNotificationService-test.pem?url=localhost",
    "https://sns.us-east-1.amazonaws.com/SimpleNotificationService-test.pem#fragment",
    "https://sns.us-east-1.amazonaws.com/other.pem",
    "https://sns.us-east-1.amazonaws.com/%2e%2e/other.pem",
  ])
    assert.throws(
      () => feedback.validateSigningCertUrl(url, topic),
      { name: "AppError" },
      url,
    );
});

test("certificate and confirmation fetches forbid redirects and temporary errors stay retriable", async () => {
  let fetched = false;
  globalThis.fetch = async (_url, init) => {
    fetched = true;
    assert.equal(init?.redirect, "error");
    assert.ok(init?.signal);
    throw new TypeError("redirect encountered");
  };
  const response = await feedback.postEmailFeedback(request(signed()));
  assert.equal(response.status, 503);
  assert.ok(fetched);
  assert.equal(receipts.size, 0);
});

test("text/plain and JSON accepted; permanent bounce only suppresses affected addresses and duplicates are harmless", async () => {
  const envelope = signed();
  assert.equal(
    (await feedback.postEmailFeedback(request(envelope))).status,
    200,
  );
  assert.equal(
    (await feedback.postEmailFeedback(request(envelope, "application/json")))
      .status,
    200,
  );
  assert.equal(receipts.size, 1);
  assert.deepEqual(addressLocks, [
    "email-address:another@example.com",
    "email-address:old@example.com",
  ]);
  assert.deepEqual([...suppressed.keys()].sort(), [
    "another@example.com",
    "old@example.com",
  ]);
  assert.equal(suppressed.has("unaffected@example.com"), false);
  assert.equal(suppressed.has("replacement@example.com"), false);
  assert.equal([...receipts.values()][0][2], "ses-message-1");
});

test("transient and undetermined bounces record without suppression or sends", async () => {
  for (const bounceType of ["Transient", "Undetermined"]) {
    const envelope = signed({
      MessageId: bounceType,
      Message: ses("Bounce", bounceType),
    });
    assert.equal(
      (await feedback.postEmailFeedback(request(envelope))).status,
      200,
    );
  }
  assert.equal(receipts.size, 2);
  assert.equal(suppressed.size, 0);
  assert.deepEqual(
    [...receipts.values()].map((receipt) => receipt[3]),
    ["bounce_transient", "bounce_undetermined"],
  );
});

test("complaints remain suppressed across out-of-order deliveries and permanent bounces", async () => {
  for (const [index, kind] of [
    "Delivery",
    "Complaint",
    "Delivery",
    "Bounce",
  ].entries()) {
    assert.equal(
      (
        await feedback.postEmailFeedback(
          request(signed({ MessageId: `event-${index}`, Message: ses(kind) })),
        )
      ).status,
      200,
    );
  }
  assert.equal(suppressed.get("old@example.com")?.reason, "complaint");
  assert.equal(receipts.size, 4);
});

test("persistence failure rolls back receipt and returns failure, then retry processes once", async () => {
  const envelope = signed();
  failWrites = true;
  assert.equal(
    (await feedback.postEmailFeedback(request(envelope))).status,
    500,
  );
  assert.equal(receipts.size, 0);
  assert.equal(suppressed.size, 0);
  failWrites = false;
  assert.equal(
    (await feedback.postEmailFeedback(request(envelope))).status,
    200,
  );
  assert.equal(
    (await feedback.postEmailFeedback(request(envelope))).status,
    200,
  );
  assert.equal(receipts.size, 1);
  assert.equal(suppressed.size, 2);
});

test("config-set eventType accepted, known non-feedback events durably ignored, malformed payloads rejected", async () => {
  const event = JSON.parse(ses("Complaint"));
  event.eventType = event.notificationType;
  delete event.notificationType;
  assert.equal(
    feedback.parseSesFeedback(JSON.stringify(event)).suppression,
    "complaint",
  );
  assert.equal(
    (
      await feedback.postEmailFeedback(
        request(signed({ Message: ses("Open") })),
      )
    ).status,
    200,
  );
  assert.equal([...receipts.values()][0][3], "ignored_open");
  for (const message of [
    "{",
    "null",
    "{}",
    JSON.stringify({
      notificationType: "Complaint",
      mail: { messageId: "x" },
      complaint: { complainedRecipients: [] },
    }),
    ses("Unrecognized"),
  ])
    assert.throws(() => feedback.parseSesFeedback(message), {
      name: "AppError",
    });
});

test("confirmation validates signed token/topic/action and persists only after successful AWS confirmation", async () => {
  const params = new URLSearchParams({
    Action: "ConfirmSubscription",
    TopicArn: topic,
    Token: "secret-token",
  });
  const envelope = signed({
    Type: "SubscriptionConfirmation",
    Token: "secret-token",
    SubscribeURL: `https://sns.us-east-1.amazonaws.com/?${params}`,
  });
  let confirmationCalls = 0;
  globalThis.fetch = async (url, init) => {
    assert.equal(init?.redirect, "error");
    if (String(url).includes(".pem")) return new Response(certificate);
    confirmationCalls++;
    return new Response("<ConfirmSubscriptionResponse />");
  };
  assert.equal(
    (await feedback.postEmailFeedback(request(envelope))).status,
    200,
  );
  assert.equal(confirmationCalls, 1);
  assert.equal([...receipts.values()][0][3], "subscription_confirmed");
  for (const SubscribeURL of [
    "https://example.com/",
    envelope.SubscribeURL!.replace("secret-token", "other-token"),
    `${envelope.SubscribeURL}&Action=DeleteTopic`,
    `${envelope.SubscribeURL}&evil=1`,
  ])
    assert.throws(
      () => feedback.validateConfirmationUrl({ ...envelope, SubscribeURL }),
      { name: "AppError" },
    );
  globalThis.fetch = async () => new Response("unavailable", { status: 503 });
  assert.equal(
    (await feedback.postEmailFeedback(request(envelope))).status,
    503,
  );
});

test("malformed, missing configuration, unsupported content type and oversized requests are rejected before writes", async () => {
  assert.equal((await feedback.postEmailFeedback(request({}))).status, 400);
  assert.equal(
    (await feedback.postEmailFeedback(request({}, "application/xml"))).status,
    415,
  );
  assert.equal(
    (await feedback.postEmailFeedback(request("x".repeat(321 * 1024)))).status,
    413,
  );
  const malformed = new Request("http://localhost/api/email/feedback", {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: "{",
  });
  assert.equal((await feedback.postEmailFeedback(malformed)).status, 400);
  delete process.env.SES_FEEDBACK_TOPIC_ARN;
  assert.equal((await feedback.postEmailFeedback(request({}))).status, 503);
  assert.equal(receipts.size, 0);
});
