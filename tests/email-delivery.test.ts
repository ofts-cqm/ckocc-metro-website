import assert from "node:assert/strict";
import { before, beforeEach, mock, test } from "node:test";
import { renderEmail } from "../src/server/email/templates";
import {
  notificationKindSql,
  notificationRecipientWhere,
} from "../src/server/operations/notifications";

let job: Record<string, unknown>;
let user: Record<string, unknown>;
let preference: Record<string, unknown>;
let suppressed = false;
let sends = 0;
let sendError: unknown;
let sent: Record<string, any>;
let clientConfig: Record<string, unknown>;
let tokenAvailable = true;
let crossMidnight = false;
let slots: {
  jobId: unknown;
  userId: unknown;
  day: unknown;
  position: number;
}[] = [];

async function query(sql: string, values: unknown[] = []) {
  if (sql.includes("SELECT position FROM metro_email_daily_slots")) {
    const rows = slots.filter(
      (slot) => slot.jobId === values[0] && slot.day === values[1],
    );
    return { rows, rowCount: rows.length };
  }
  if (sql.includes("count(*)::integer AS used FROM metro_email_daily_slots"))
    return {
      rows: [
        {
          used: slots.filter(
            (slot) => slot.userId === values[0] && slot.day === values[1],
          ).length,
        },
      ],
      rowCount: 1,
    };
  if (sql.includes("INSERT INTO metro_email_daily_slots"))
    slots.push({
      jobId: values[0],
      userId: values[1],
      day: values[2],
      position: Number(values[3]),
    });
  if (sql.includes("SET status='sending'")) {
    if (job.status !== "pending") return { rows: [], rowCount: 0 };
    job.status = "sending";
    job.attempts = Number(job.attempts) + 1;
    job.lease_token = values[1];
    return { rows: [{ ...job }], rowCount: 1 };
  }
  if (sql.includes("SELECT u.email")) return { rows: [user], rowCount: 1 };
  if (sql.includes("SELECT enabled,consent_version"))
    return { rows: [preference], rowCount: 1 };
  if (sql.includes("SELECT purpose,source_email"))
    return {
      rows: tokenAvailable
        ? [
            {
              purpose: "verification",
              source_email: user.email,
              auth_version: user.auth_version,
            },
          ]
        : [],
      rowCount: tokenAvailable ? 1 : 0,
    };
  if (sql.includes("SELECT address FROM metro_email_suppressions"))
    return { rows: suppressed ? [{}] : [], rowCount: suppressed ? 1 : 0 };
  if (sql.includes("UPDATE metro_email_jobs SET status=$3")) {
    job.status = values[2];
    job.error_code = values[3];
    if (sql.includes("ses_message_id=COALESCE")) job.ses_message_id = values[4];
  }
  return { rows: [], rowCount: 1 };
}
mock.module("../src/server/db/index.ts", {
  namedExports: {
    query,
    transaction: async (fn: (client: unknown) => unknown) => fn({ query }),
  },
});
mock.module("@aws-sdk/client-sesv2", {
  namedExports: {
    SESv2Client: class {
      constructor(config: Record<string, unknown>) {
        clientConfig = config;
        if (crossMidnight) mock.timers.tick(2000);
      }
      async send(command: { input: Record<string, any> }) {
        sends++;
        sent = command.input;
        if (sendError) throw sendError;
        return { MessageId: "ses-id" };
      }
      destroy() {}
    },
    SendEmailCommand: class {
      constructor(public input: Record<string, unknown>) {}
    },
  },
});
let jobs: typeof import("../src/server/email/jobs");
before(async () => {
  jobs = await import("../src/server/email/jobs");
});
beforeEach(() => {
  process.env.EMAIL_NOTIFICATIONS_ENABLED = "true";
  process.env.AWS_REGION = "us-east-1";
  process.env.SES_FROM_EMAIL = "sender@example.test";
  process.env.APP_URL = "http://localhost:3000";
  process.env.EMAIL_TOKEN_SECRET = "test-email-secret-".repeat(3);
  delete process.env.EMAIL_NOTIFICATIONS_PER_DAY;
  slots = [];
  crossMidnight = false;
  job = {
    id: "00000000-0000-4000-8000-000000000001",
    user_id: "recipient",
    kind: "notification",
    address: "recipient@example.test",
    consent_version: 2,
    locale: "en-us",
    payload: {
      notificationKind: "reply",
      sender: "Sender",
      issueNumber: 12,
      source: { comment: "4321" },
    },
    status: "pending",
    attempts: 0,
    token_id: null,
  };
  user = {
    email: "recipient@example.test",
    emailVerified: true,
    active: true,
    auth_version: 1,
  };
  preference = { enabled: true, consent_version: 2 };
  suppressed = false;
  sends = 0;
  sendError = undefined;
  tokenAvailable = true;
});

test("sender submits one-recipient HTML/plain email once under concurrent delivery", async () => {
  await Promise.all([
    jobs.executeEmailJob(String(job.id)),
    jobs.executeEmailJob(String(job.id)),
  ]);
  assert.equal(sends, 1);
  assert.equal(job.status, "submitted");
  assert.equal(job.ses_message_id, "ses-id");
  assert.deepEqual(sent.Destination, {
    ToAddresses: ["recipient@example.test"],
  });
  assert.match(sent.Content.Simple.Body.Text.Data, /\/en-us\/issues\/12/);
  assert.match(sent.Content.Simple.Body.Html.Data, /email\/unsubscribe#token=/);
  assert.equal(clientConfig.maxAttempts, 1);
  assert.match(sent.Content.Simple.Body.Text.Data, /4321/);
});
test("queued notifications recheck active status, verification, consent and address", async () => {
  for (const [change, code] of [
    [
      () => {
        user.active = false;
      },
      "account_inactive",
    ],
    [
      () => {
        user.emailVerified = false;
      },
      "address_unverified",
    ],
    [
      () => {
        user.email = "replacement@example.test";
      },
      "address_changed",
    ],
    [
      () => {
        preference.enabled = false;
      },
      "consent_changed",
    ],
    [
      () => {
        preference.consent_version = 3;
      },
      "consent_changed",
    ],
    [
      () => {
        suppressed = true;
      },
      "address_suppressed",
    ],
  ] as const) {
    user = {
      email: "recipient@example.test",
      emailVerified: true,
      active: true,
      auth_version: 1,
    };
    preference = { enabled: true, consent_version: 2 };
    suppressed = false;
    job.status = "pending";
    job.attempts = 0;
    change();
    await jobs.executeEmailJob(String(job.id));
    assert.equal(job.status, "skipped");
    assert.equal(job.error_code, code);
  }
  assert.equal(sends, 0);
  assert.equal(
    slots.length,
    0,
    "ineligible recipients do not consume daily quota",
  );
});
test("disabled sending leaves pending work untouched", async () => {
  process.env.EMAIL_NOTIFICATIONS_ENABLED = "false";
  await jobs.executeEmailJob(String(job.id));
  assert.equal(sends, 0);
  assert.equal(job.status, "pending");
});
test("expired verification is skipped and valid unverified mailbox can receive verification", async () => {
  job.kind = "verification";
  job.token_id = "00000000-0000-4000-8000-000000000002";
  user.emailVerified = false;
  tokenAvailable = false;
  await jobs.executeEmailJob(String(job.id));
  assert.equal(sends, 0);
  assert.equal(job.error_code, "verification_expired");
  tokenAvailable = true;
  job.status = "pending";
  await jobs.executeEmailJob(String(job.id));
  assert.equal(sends, 1);
  assert.match(sent.Content.Simple.Body.Text.Data, /email\/verify#token=/);
  assert.equal(slots.length, 0, "verification is independently rate limited");
});
test("confirmed throttling retries with bounded attempts; ambiguous failures never resend", async () => {
  sendError = {
    name: "TooManyRequestsException",
    $metadata: { httpStatusCode: 429 },
  };
  assert.deepEqual(await jobs.executeEmailJob(String(job.id)), {
    retry: true,
    delay: 60,
  });
  assert.equal(job.status, "pending");
  job.attempts = 4;
  assert.deepEqual(await jobs.executeEmailJob(String(job.id)), {
    retry: false,
    delay: 960,
  });
  assert.equal(job.status, "failed");
  job.status = "pending";
  job.attempts = 0;
  sendError = new Error("socket closed");
  assert.deepEqual(await jobs.executeEmailJob(String(job.id)), {
    retry: false,
    delay: 60,
  });
  assert.equal(job.status, "outcome_unknown");
  await jobs.executeEmailJob(String(job.id));
  assert.equal(sends, 3);
  assert.equal(
    slots.length,
    1,
    "retries reuse their daily slot and uncertainty retains it",
  );
  assert.deepEqual(
    jobs.classifySendFailure({ $metadata: { httpStatusCode: 403 } }),
    { status: "failed", code: "ses_unauthorized" },
  );
  assert.equal(
    jobs.classifySendFailure({ $metadata: { httpStatusCode: 503 } }).status,
    "outcome_unknown",
  );
});
test("templates escape user text, localize content and include scoped links", () => {
  const content = renderEmail({
    kind: "notification",
    locale: "zh-HK",
    origin: "https://metro.example",
    payload: {
      notificationKind: "reply",
      sender: "<script>\r\nInjected",
      issueNumber: 7,
    },
    unsubscribeToken: "opaque",
  });
  assert.match(content.html, /&lt;script&gt;/);
  assert.doesNotMatch(content.html, /<script>/);
  assert.doesNotMatch(content.subject, /[\r\n]/);
  assert.match(content.text, /回覆了您/);
  assert.match(content.text, /\/zh-hk\/issues\/7/);
  assert.match(content.text, /https:\/\/metro\.example\/zh-hk\/settings/);
});
test("shared recipient SQL retains general thoughts, parent repository match and self exclusion", () => {
  const where = notificationRecipientWhere("u.id");
  assert.match(where, /payload->>'kind'='general'/);
  assert.match(where, /parent.actor_id=u.id/);
  assert.match(where, /o.actor_id<>u.id/);
  assert.match(
    where,
    /parent.checkpoint->>'repository'=o.checkpoint->>'repository'/,
  );
  assert.match(notificationKindSql("u.id"), /THEN 'reply' ELSE 'mention'/);
});

test("default daily cap skips the sixth notification and adds the notice only to the fifth", async () => {
  let warnings = 0;
  for (let i = 1; i <= 7; i++) {
    job.id = `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
    job.status = "pending";
    job.attempts = 0;
    job.ses_message_id = null;
    await jobs.executeEmailJob(String(job.id));
    if (i <= 5) {
      assert.equal(job.status, "submitted");
      const warned = sent.Content.Simple.Body.Text.Data.includes(
        "you won’t receive any more notification emails today",
      );
      assert.equal(warned, i === 5);
      if (warned) warnings++;
    } else {
      assert.equal(job.status, "skipped");
      assert.equal(job.error_code, "daily_email_limit");
      assert.equal(job.ses_message_id, null);
    }
  }
  assert.equal(sends, 5);
  assert.equal(slots.length, 5);
  assert.equal(warnings, 1);
});

test("daily limit is configurable and the first email carries the notice when limit is one", async () => {
  process.env.EMAIL_NOTIFICATIONS_PER_DAY = "1";
  await jobs.executeEmailJob(String(job.id));
  assert.equal(sends, 1);
  assert.match(
    sent.Content.Simple.Body.Text.Data,
    /you won’t receive any more notification emails today/,
  );
  assert.match(sent.Content.Simple.Body.Html.Data, /notifications=open/);
});

test("invalid daily limits fall back to five", async () => {
  const { notificationDailyLimit } = await import("../src/server/email/quota");
  for (const value of ["", "0", "-1", "no", "1.5", "9007199254740992"]) {
    process.env.EMAIL_NOTIFICATIONS_PER_DAY = value;
    assert.equal(notificationDailyLimit(), 5);
  }
  process.env.EMAIL_NOTIFICATIONS_PER_DAY = " 12 ";
  assert.equal(notificationDailyLimit(), 12);
});

test("a send delayed across UTC midnight reserves the new day before submission", async () => {
  mock.timers.enable({ apis: ["Date"], now: Date.UTC(2026, 0, 1, 23, 59, 59) });
  try {
    crossMidnight = true;
    const delayed = await jobs.executeEmailJob(String(job.id));
    assert.equal(delayed.retry, true);
    assert.equal(job.status, "pending");
    assert.equal(sends, 0);
    assert.equal(slots[0].day, "2026-01-01");
    crossMidnight = false;
    await jobs.executeEmailJob(String(job.id));
    assert.equal(sends, 1);
    assert.equal(job.status, "submitted");
    assert.equal(slots[1].day, "2026-01-02");
  } finally {
    mock.timers.reset();
  }
});

test("map updates use their own consent and the shared notification cap", async () => {
  process.env.EMAIL_NOTIFICATIONS_PER_DAY = "1";
  preference = {
    enabled: false,
    consent_version: 1,
    map_updates: true,
    map_consent_version: 2,
  };
  user.role = "subscriber";
  job.payload = {
    notificationKind: "map-update",
    summary: "New stations <script>",
  };
  await jobs.executeEmailJob(String(job.id));
  assert.equal(sends, 1);
  assert.match(sent.Content.Simple.Subject.Data, /metro map has been updated/);
  assert.doesNotMatch(
    sent.Content.Simple.Body.Text.Data,
    /notifications=open|issues\//,
  );
  assert.match(sent.Content.Simple.Body.Html.Data, /&lt;script&gt;/);
  job.id = "00000000-0000-4000-8000-000000000003";
  job.status = "pending";
  await jobs.executeEmailJob(String(job.id));
  assert.equal(sends, 1);
  assert.equal(job.error_code, "daily_email_limit");
});

test("map opt-out and demotion invalidate queued emails independently", async () => {
  preference = {
    enabled: true,
    consent_version: 2,
    map_updates: false,
    map_consent_version: 3,
  };
  job.payload = { notificationKind: "map-update" };
  await jobs.executeEmailJob(String(job.id));
  assert.equal(job.error_code, "consent_changed");
  job.status = "pending";
  job.payload = { notificationKind: "reply" };
  user.role = "subscriber";
  await jobs.executeEmailJob(String(job.id));
  assert.equal(job.error_code, "role_changed");
  assert.equal(sends, 0);
});

test("discussion and map updates consume the same account daily allowance", async () => {
  process.env.EMAIL_NOTIFICATIONS_PER_DAY = "2";
  preference = {
    enabled: true,
    consent_version: 2,
    map_updates: true,
    map_consent_version: 2,
  };
  user.role = "collaborator";
  await jobs.executeEmailJob(String(job.id));
  job.id = "00000000-0000-4000-8000-000000000002";
  job.payload = { notificationKind: "map-update" };
  job.status = "pending";
  await jobs.executeEmailJob(String(job.id));
  assert.equal(sends, 2);
  job.id = "00000000-0000-4000-8000-000000000003";
  job.payload = { notificationKind: "reply" };
  job.status = "pending";
  await jobs.executeEmailJob(String(job.id));
  assert.equal(job.error_code, "daily_email_limit");
  assert.equal(sends, 2);
  assert.equal(slots.length, 2);
});

test("deleted account jobs cannot submit another email", async () => {
  job.user_id = null;
  await jobs.executeEmailJob(String(job.id));
  assert.equal(sends, 0);
  assert.equal(job.status, "skipped");
  assert.equal(job.error_code, "account_deleted");
});
