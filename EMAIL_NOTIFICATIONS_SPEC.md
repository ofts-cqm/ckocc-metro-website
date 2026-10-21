# Email notifications with Amazon SES

Status: implemented locally; production rollout remains a separate operation.
This document does not itself enable email delivery or change AWS resources.

## Implemented decisions

- One explicit opt-in covers replies, mentions, and applicable administrator alerts.
  Preferences and mailbox verification are independent; both are required to send.
- Notifications include the original comment/general thought or full line-request
  details, escaped in HTML and preserved in plain text.
- `EMAIL_NOTIFICATIONS_PER_DAY` defaults to five notification emails per account
  per UTC calendar day. Migration 004 stores durable per-job daily reservations;
  retries reuse reservations, and failures/uncertain outcomes retain them. The last
  allowed notification contains a localized daily-limit notice and an inbox link.
  Further jobs are skipped permanently; the website inbox is unaffected.
  Verification emails retain their independent abuse limits.
- The localized settings page supports mailbox verification and password-protected
  address replacement. The existing login email remains until the replacement is
  verified, then all sessions are revoked. Verification links expire after one hour.
- Verification and unsubscribe links carry scoped tokens in URL fragments, which
  are removed by the confirmation page. Only a confirmation POST changes state.
  The database stores token hashes; the sender reconstructs tokens using a
  domain-separated server-secret HMAC. Unsubscribe links expire after one year.
- Migration `003_email_notifications.sql` adds dedicated durable email tables and
  records the initial launch cutoff. Successful operations and repair use the same
  recipient predicates as the website inbox. No historical backfill is performed.
- Workflow sends are launched after commit and recovered through the existing
  repair mechanism. SES SDK retries are disabled; uncertain submissions stay
  `outcome_unknown`. Administrator diagnostics expose IDs and bounded error codes.
- Address suppression and sending share an address lock. Feedback is deduplicated
  transactionally and remains correlatable by SES ID when events arrive early.
- Local live acceptance targets SES simulator addresses only. Real mailbox content,
  inbox placement, and SPF/DKIM/DMARC inspection are outside that acceptance run.

## Local validation record (2026-10-21)

- Content/daily-cap update: migration 004 applied locally; 17 focused sender/template
  tests, the full unit suite, three isolated PostgreSQL acceptance scripts, 13
  browser tests, typecheck, formatting, and production build passed. Concurrent
  seven-job testing admitted five notifications, added one final-email notice,
  and skipped two. UTC rollover, retry reuse, account isolation, and login-to-inbox
  links were verified. These checks used mocked SES and sent no external email.
- Passed 109 unit tests across 15 files, 30 browser tests, isolated PostgreSQL
  account and delivery acceptance scripts, typecheck, and production build.
- Applied migration 003 to the development database. The public tunnel reached
  `/api/email/feedback` and the handler rejected malformed feedback with HTTP 400.
  Live local account/admin routes rejected unauthenticated requests.
- The initial live send was rejected with HTTP 403 `AccessDeniedException`. After
  the IAM correction, the application successfully submitted all three simulator
  messages (success, bounce, complaint) and persisted their SES message IDs.
- SNS subscription confirmation was recorded at 21:29:19 UTC. After confirmation,
  a fresh bounce simulator job (`7b6290bb-9269-47ab-a7fb-b5df4bbde8a9`) was submitted
  through the application worker. Signed permanent-bounce feedback arrived at
  21:32:07 UTC and durably suppressed the simulator address. A subsequent job
  (`3eb70b41-54fe-4ea2-b9f1-1b594730fe6a`) was skipped with `address_suppressed`
  and no SES submission. The real bounce path passed end to end.
- A fresh complaint simulator job (`eeb174c6-e2c2-4127-8f03-3dda8d6c5fe8`) was
  submitted through the application worker after confirmation. Signed complaint
  feedback arrived at 21:33:56 UTC and durably suppressed the simulator address
  with reason `complaint`. A subsequent job
  (`3df21a8b-d3ec-4de4-ac15-45e8ab1f809d`) was skipped with `address_suppressed`
  and no SES submission. Both real bounce and complaint paths passed end to end.

## Scope and existing behavior

Add opt-in transactional email notifications for replies, mentions, and administrator
line-request alerts. Cover comments and general thoughts consistently with the
existing website inbox. Preserve administrator-created accounts and existing
recipient validation, guest mention quotas, and self-notification exclusion.

The current inbox is derived from successful `metro_operations` in
`src/server/operations/notifications.ts`; read markers use `metro_audit`.
Email delivery must not depend on someone loading that inbox or mark an inbox item
read. Email suppression must not remove website notifications.

The account schema already contains `email` and `emailVerified`; account creation
currently sets verification to false. Do not treat an administrator-entered address
as proof of mailbox ownership.

## AWS architecture

```text
Successful app operation → durable email job → server-side SES API
                                                   ↓
                                            recipient mail server
                                                   ↓
SES bounce/complaint feedback → SNS Standard topic → HTTPS feedback endpoint
                                                   ↓
                                      app delivery and suppression records
```

Use the AWS SDK for JavaScript v3, `@aws-sdk/client-sesv2`, on the server.
Use one recipient per message to simplify attribution and avoid exposing addresses.
Record the SES message ID returned by each successful API submission. API acceptance
means submitted, not delivered to an inbox.

### Credentials and configuration

Authenticate sending through AWS credentials, not an SES-specific API key. Prefer
temporary role credentials where supported; a dedicated IAM user's access keys are
an initial alternative. Never use root credentials or expose credentials to browsers.
SMTP credentials are separate and are not used by this API design.

Proposed server-only configuration:

| Variable | Purpose |
| --- | --- |
| `AWS_REGION` | Region containing the SES identity and SNS topic |
| `AWS_ACCESS_KEY_ID` | Dedicated sender access key, if using static credentials |
| `AWS_SECRET_ACCESS_KEY` | Corresponding secret, if using static credentials |
| `AWS_SESSION_TOKEN` | Required when credentials are temporary and supplied through environment variables |
| `SES_FROM_EMAIL` | Verified-domain sender, e.g. `notifications@example.com` |
| `SES_REPLY_TO_EMAIL` | Optional monitored support address |
| `SES_FEEDBACK_TOPIC_ARN` | Exact SNS topic accepted by the feedback endpoint |
| `EMAIL_NOTIFICATIONS_ENABLED` | Explicit switch controlling notification sending |

Use the SDK credential provider chain. Store local secrets in ignored local
configuration and deployed secrets in the hosting environment. Never prefix secrets
with `NEXT_PUBLIC_`, commit them, or log them. Keep development and production
credentials, topics, and databases separate.

Give the sending identity only `ses:SendEmail` for the verified identity ARN, with
a `ses:FromAddress` restriction to the configured sender. If the app confirms SNS
subscriptions through the API, separately grant only the required confirmation
permission for the intended topic. No broad SES administrator permission is needed.

## Sender identity and DNS

Before sending:

1. Verify the sending domain in the chosen SES region with Easy DKIM and publish
   the generated CNAME records exactly as supplied by SES.
2. Publish or review DMARC. Start with monitoring (`p=none`) while validating all
   legitimate senders; add aggregate reporting only to an existing receiving
   mailbox or reporting service. Strengthen policy after checking authentication.
3. Optionally configure a dedicated custom MAIL FROM subdomain such as
   `bounce.example.com`, with SES's regional MX record and SPF TXT record.

The visible From address is `notifications@example.com`. Verifying its domain
allows sending from it without creating a mailbox or a DNS record per address.
The custom MAIL FROM domain handles envelope-sender/bounce routing; SES manages
the generated addresses. A Reply-To address determines where human replies go.
Receiving regular mail requires a separate mailbox/forwarding provider.

Preserve existing root-domain mailbox MX records. Publish the SES MX record only
on the dedicated MAIL FROM subdomain. DKIM can provide DMARC alignment without
custom MAIL FROM; custom MAIL FROM additionally supports relaxed SPF alignment.

## Recipient consent and verification

- Notification email is off until the user explicitly opts in.
- Require proof of mailbox ownership before regular notifications are enabled.
  Implement expiring, single-use verification links with hashed tokens and
  rate limits. Verification messages necessarily precede verified status, but
  must still respect address suppression and abuse limits.
- Provide controls for the supported notification categories and a way to disable
  all notification email. This implementation uses one switch for all applicable
  categories, as selected during planning.
- Include a preferences/disable link in notification messages. Any unauthenticated
  disable link must use a scoped token; never expose a general account token.
- Changing the email address requires fresh verification. A newly verified address
  must not inherit the old address's suppression status.
- Recheck active account status, current address, verification, preferences, and
  suppression immediately before sending, including queued messages.

## Creating and sending email jobs

- Create durable email work from successful operations only. Reuse the inbox's
  recipient rules rather than introducing a divergent interpretation.
- Deduplicate by source operation and recipient. When the same operation both
  replies to and mentions a recipient, send one message, matching inbox precedence.
- Establish a launch cutoff: do not email historical inbox items by default.
- Persist pending work and process it with a durable worker or supported workflow;
  do not rely on an unawaited task after an HTTP response.
- Keep the website operation successful even if email delivery fails. Email failures
  need their own status and recovery path.
- Store recipient address at submission time, source operation, attempt state,
  timestamps, and SES message ID. Correlate feedback with those sending records.
- Retry transient API failures with bounded backoff. An ambiguous network timeout
  can mean SES accepted the message: record uncertainty and avoid blind resending.
  SES SendEmail does not provide an application deduplication guarantee.
- Send escaped HTML and a plain-text alternative with a link to the relevant site
  item. Avoid placing sensitive content or authentication tokens in logs.

## Bounce and complaint handling

Enable/check the SES account-level suppression list for both bounces and complaints.
This is an AWS-side safeguard; the application must maintain suppression too, so it
does not repeatedly submit messages SES will decline to deliver.

Configure the SES identity to publish bounce and complaint events to an SNS
Standard topic in the same region. Its resource policy must allow SES to publish,
restricted by the expected AWS account and SES identity ARN.
Subscribe the app's HTTPS endpoint with raw message delivery disabled.
Identity-level SNS notifications are the initial design; configuration-set event
publishing is an alternative, not a second required parallel pipeline.

Proposed endpoint: `POST /api/email/feedback` (Next.js Node.js runtime).

The handler must:

1. Accept SNS JSON envelopes, including requests labelled `text/plain`, with a
   bounded body size and schema validation.
2. Verify the SNS signature and exact topic ARN before processing notifications or
   confirmation messages. Validate signing-certificate URLs against AWS SNS's
   documented rules; never fetch arbitrary URLs from untrusted payloads.
3. Handle `SubscriptionConfirmation` using the authenticated topic and token through
   the SNS API, or a validated AWS confirmation URL. Do not blindly fetch a supplied
   `SubscribeURL`. No website login or interactive challenge may block SNS access.
4. For `Notification`, parse the SES JSON inside the envelope's `Message` field.
   Identity notifications use `notificationType`; configuration-set events use
   `eventType` if that alternative is adopted.
5. Persist event processing and resulting suppression atomically and idempotently.
   Accept multiple affected recipients, tolerate unknown extra fields, and do not
   assume ordering. Use the affected-recipient fields rather than suppressing every
   address in the original destination list.
6. Return 2xx only after durable handling, including harmless duplicates or explicitly
   ignored supported events. Return a failure for temporary persistence errors so
   SNS can retry. Reject invalid signatures and unexpected topics without changes.

| Event | Required behavior |
| --- | --- |
| Permanent bounce | Suppress the affected address from future sends |
| Transient bounce | Record failure; do not permanently suppress after one event or immediately resend a message SES may already have retried |
| Undetermined bounce | Record for review; do not silently classify as permanent |
| Complaint | Immediately suppress future notification email to the affected address |
| Delivery, if enabled | Record as delivery to the receiving server; never clear suppression |

Suppression belongs to the email address, not just the account. Delayed feedback
for an old address must not disable a replacement address. Keep suppression separate
from notification preferences and inbox read state. Do not automatically remove
complaint suppression when someone toggles preferences or on successful delivery.
Recovery requires an explicit, reviewed process and reconciliation with SES's list.

## Persistence and migrations

Implementation needs durable preferences, verification-token handling, email jobs,
feedback deduplication, and address suppression. Logical records should capture:

- Preferences and consent: user, enabled categories, consent/update timestamps.
- Suppression: address lookup key, reason, suppression time, originating feedback.
- Delivery job: source operation, user, recipient snapshot, status, attempts, SES
  message ID, timestamps, and bounded error metadata.
- Feedback receipt: unique SNS message identity, SES message ID, event kind, affected
  recipients, and processing time.

These requirements are implemented by dedicated `metro_email_*` tables in migration
003. Existing inbox migrations do not provide email persistence. Apply the new
migration before running the updated email paths.

## Local testing without production deployment

1. Run the app against a dedicated development database.
2. Start a temporary HTTPS tunnel, for example:

   ```bash
   cloudflared tunnel --url http://localhost:3000
   ```

3. Subscribe `https://<temporary-host>/api/email/feedback` to the development SNS
   topic and verify confirmation. Restarting a temporary tunnel may require a new
   subscription. Remove stale subscriptions after testing.
4. Keep the tunnel and app running. Its public URL forwards SNS requests to localhost;
   production deployment is not required. Do not place interactive access protection
   in front of the webhook; retain SNS signature validation.
5. Send through the actual application sender to SES simulator recipients:

   | Recipient | Scenario |
   | --- | --- |
   | `success@simulator.amazonses.com` | Successful delivery |
   | `bounce@simulator.amazonses.com` | Permanent bounce |
   | `complaint@simulator.amazonses.com` | Complaint |

The simulator works in the SES sandbox without verifying those recipient addresses.
It does not affect reputation bounce/complaint rates. Assert application suppression
in the development database; do not depend on simulator addresses being added to
SES's real suppression list. Use controlled development fixtures to associate
simulator addresses with jobs; never add a production verification bypass.

For content/inbox authentication tests, send to a real, separately verified test
recipient while in the sandbox. Inspect SPF, DKIM, and DMARC results.

## Acceptance criteria

- Successful eligible operations produce one email job per recipient; failed
  operations, historical events, self-events, and duplicate triggers do not.
- Unverified, inactive, opted-out, or suppressed recipients receive no regular
  notification email; queued work respects later preference/address changes.
- The real SES → SNS → tunnel → local database path passes for bounce and complaint.
  A subsequent notification to each suppressed test address is skipped.
- Forged signatures, unexpected topics, unsafe certificate/confirmation URLs, and
  malformed messages cannot mutate delivery state.
- Repeated and out-of-order feedback is harmless. Delivery cannot undo suppression;
  delayed feedback for an old address cannot suppress the new address.
- Persistence failures cause a retriable response; processing succeeds once after
  retry. Temporary sending failures and ambiguous outcomes retain accurate states.
- Email failures leave website inbox and operation behavior intact. General thoughts
  and comments follow the same recipient rules.
- Logs expose enough identifiers for diagnosis without credentials, tokens, or full
  email bodies. An operator can find failed jobs and confirm webhook failures.

## Rollout and production access

Sequence: configure SES/DNS → implement and test in sandbox → request production
access → enable user delivery after approval and deployment checks.

Production access is regional and needed for arbitrary unverified recipients.
Sandbox testing permits only verified recipients and simulator addresses, with
restricted sending rates/quotas. Sender identity verification remains required
after production approval.

Request transactional sending access with the real website URL, expected volume,
consent process, and implemented bounce/complaint handling. Do not claim unfinished
features exist. Deploy with notification sending disabled, confirm the permanent
SNS subscription and database migration, then enable gradually and monitor SES
reputation, suppression, and application delivery failures.

## References

- [SES credentials](https://docs.aws.amazon.com/ses/latest/dg/send-email-concepts-credentials.html)
- [AWS SDK credentials](https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/setting-credentials.html)
- [SES identities and DKIM](https://docs.aws.amazon.com/ses/latest/dg/creating-identities.html)
- [Custom MAIL FROM](https://docs.aws.amazon.com/ses/latest/dg/mail-from.html)
- [DMARC](https://docs.aws.amazon.com/ses/latest/dg/send-email-authentication-dmarc.html)
- [SES to SNS configuration and topic policy](https://docs.aws.amazon.com/ses/latest/dg/configure-sns-notifications.html)
- [Feedback payloads](https://docs.aws.amazon.com/ses/latest/dg/notification-contents.html)
- [SNS signature verification](https://docs.aws.amazon.com/sns/latest/dg/sns-verify-signature-of-message.html)
- [SES suppression list](https://docs.aws.amazon.com/ses/latest/dg/sending-email-suppression-list.html)
- [Mailbox simulator](https://docs.aws.amazon.com/ses/latest/dg/send-an-email-from-console.html)
- [Production access](https://docs.aws.amazon.com/ses/latest/dg/request-production-access.html)
- [Cloudflare Quick Tunnels](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/)
