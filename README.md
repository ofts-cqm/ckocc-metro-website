# CKOCC Metro

A metro map and request portal for the Minecraft server, built with Next.js, PostgreSQL, Better Auth, GitHub App installation authentication, Vercel Blob, and Vercel Workflow.

Players submit requests and comments without an account. Invited collaborators upload a Rail Map Painter JSON/PNG pair and submit a PR. An administrator reviews and merges from the Updates page or GitHub. The website publishes approved map revisions.

Signed-in collaborators and administrators can close public requests from the request page. Their account's in-game display name is automatically attached to general and line-update requests and cannot be changed in the form or overridden through the submission API.

The interface supports `/en-us`, `/zh-cn`, and `/zh-hk`. Station dimensions accept arbitrary text and default to `overworld`; English names and line identifiers are optional, and line numbers are strings.

## Current handoff

Implementation and local database setup are in this workspace. Login and service connections have received focused live checks. The owner chose comprehensive local acceptance against `ofts-cqm/ckocc-metro-map-test`, followed by a brief check after deployment. See the [current testing decision and checklist](IMPLEMENTATION_STATUS.md#current-testing-decision--6-october-2026) and the [original design](IMPLEMENTATION_PLAN.md).

## Local development

Use Node.js 22.18 or later and npm. Dependency versions are pinned in `package-lock.json`.

```sh
npm ci
npm run dev
```

Until the first map publication is ready, the home page uses the real, approved bootstrap map and marks it as a reference snapshot. Configuring PostgreSQL alone does not remove this map. The small local overview avoids loading the 160-million-pixel original on initial display; the original remains available through the full-detail link.

For backend work, copy `.env.example` to **`.env.local`**, leaving the existing secret `.env` and PEM intact. Fill the documented variables using separate development resources. Next.js loads these files; the operator commands load `.env` then `.env.local`. Environment variables already exported in the shell take precedence.

After provisioning a development PostgreSQL database, these commands apply schema changes and create the first administrator. The local database now has both migrations applied; administrator bootstrap has not been run:

```sh
npm run db:migrate
npm run admin:bootstrap
```

Bootstrap prompts for email, display name, and a hidden password in an interactive terminal. It refuses if an administrator already exists. Admins then create invitations through the website. There is no public registration or public bootstrap route. Migration checksums are recorded; add a new migration after deployment instead of editing an applied file. Use a direct database connection for migrations because their advisory lock is session-scoped; the app's normal `DATABASE_URL` can use transaction pooling.

### Prepare the production email database before deployment

Set `PRODUCTION_DATABASE_URL` to the production database's **direct connection URL**, either in your shell or in the ignored file `.env.prod-migrations`:

```dotenv
PRODUCTION_DATABASE_URL=postgresql://USER:PASSWORD@HOST/DATABASE?sslmode=verify-full
```

Use the TLS settings and CA certificate required by your database provider. Then run:

```sh
# Read-only prerequisite/checksum check; lists pending email migrations.
npm run db:migrate:email:prod -- --check

# Apply only 003_email_notifications.sql and 004_email_daily_limit.sql.
npm run db:migrate:email:prod

# Verify both are recorded as applied.
npm run db:migrate:email:prod -- --check
```

This command does not load `.env` or `.env.local`, and requires `PRODUCTION_DATABASE_URL` rather than falling back to `DATABASE_URL`. It requires migrations 001 and 002 to be recorded with matching checksums, validates all four checksums before applying anything, and skips 003/004 if already applied. Each migration is transactional; if 004 fails after 003 succeeds, rerunning resumes with 004. Future migrations are excluded from this command.

These migrations prepare the email tables, launch cutoff, and daily quota without deploying the app or sending email. Keep production `EMAIL_NOTIFICATIONS_ENABLED=false` until deployment and delivery checks are complete. Migration 003 records its execution time as the cutoff; users remain opted out until they explicitly opt in and verify their address.

Bootstrap checks database access before requesting a password. Failures identify the affected step and provide specific guidance for invalid inputs, mismatched passwords, existing accounts, connection failures, and missing migrations; raw provider errors and credentials are never printed. Passwords must contain 8–128 characters, including any spaces. If the command fails, share only its final error message, never your password or `DATABASE_URL`.

Website login also needs `APP_URL`, `BETTER_AUTH_URL`, `BETTER_AUTH_SECRET`, and `ABUSE_HASH_SECRET` in `.env.local`; database setup and administrator bootstrap alone do not configure login. For local development, use `http://localhost:3000` for both URLs and generate independent random secrets of at least 32 characters. Restart `npm run dev` after changing environment variables. Open the site using the configured URL so login's origin check matches.

For temporary local testing, set `DISABLE_RATE_LIMITS=true` in `.env.local`. This skips application rate limits in development/test; production always enforces them. Set it back to `false` (or remove it) to restore limits. Restart the development server after changing it. Authentication, Turnstile, and the public-submission pause still apply.

Configure per-IP limits for new requests and comments in `.env.local` (or your deployment environment): `NEW_REQUESTS_PER_HOUR=3`, `NEW_REQUESTS_PER_DAY=10`, `NEW_COMMENTS_PER_HOUR=10`, and `NEW_COMMENTS_PER_DAY=30`. Values must be positive integers; missing or invalid values use the defaults shown here. The hourly and daily windows remain fixed at one hour and one day. Restart the server after changing these options.

Guest mentions have a separate per-IP daily allowance: `GUEST_MENTIONS_PER_DAY=3`. Each distinct selected account in a comment or general thought uses one allowance; plain `@` text without a selected account does not. Reply and mention notifications appear in the website inbox for active accounts. Successful public line requests also notify active administrators when the checked-by-default form option is selected. Optional email delivery follows the same recipient rules; see [email notifications](EMAIL_NOTIFICATIONS_SPEC.md).

### Email notifications

Apply `003_email_notifications.sql` with `npm run db:migrate`. It adds email preferences, scoped verification/unsubscribe tokens, durable jobs and their workflow outbox, SNS receipts, address suppression, and a launch cutoff. Existing users are opted out. Historical notifications are not backfilled. Settings let signed-in users opt in, verify their mailbox, or request a password-protected email change. The original login address stays active until the replacement is verified; changing it revokes sessions. Opting out or changing addresses invalidates queued notifications.

Configure `AWS_REGION`, `SES_FROM_EMAIL`, and the exact `SES_FEEDBACK_TOPIC_ARN`; use the AWS SDK credential chain and optional `SES_REPLY_TO_EMAIL`. Keep `EMAIL_NOTIFICATIONS_ENABLED=false` until the environment is ready. `APP_URL` supplies email links and must be HTTPS in production. Verification email is also gated by the sending switch. `EMAIL_TOKEN_SECRET` optionally separates link signing from the auth secret. Never expose these values through `NEXT_PUBLIC_` variables.

Notification emails include the original reply/mention text or request details in escaped HTML and plain text. Apply `004_email_daily_limit.sql` for the per-account daily cap: `EMAIL_NOTIFICATIONS_PER_DAY=5` by default (positive integer; missing/invalid values use 5). The allowance resets at 00:00 UTC and applies across all notification categories, roles, and email-address changes. Verification messages retain their separate abuse limits. The last allowed notification includes a localized notice and a link that opens the website inbox, prompting login if needed. Further jobs are permanently skipped with `daily_email_limit`; website inbox items remain available and skipped emails are not replayed tomorrow.

Daily slots are committed before SES submission and reused by retries of the same job that day. Reserved slots remain counted after a sending failure or uncertain outcome, so a failure can reduce the number actually received; this conservatively prevents duplicate/uncertain sends from exceeding the cap. Accounts rejected as inactive, unverified, opted out, or suppressed before reservation consume no slots. Migration 004 counts existing submitted/uncertain notifications and adds source content to pending jobs.

Subscribe the development SNS topic to `https://<tunnel>/api/email/feedback` with raw delivery disabled. The handler verifies signatures and can confirm authenticated subscriptions. It remains active when sending is disabled. Configure SES identity bounce and complaint notifications to this topic. Verify AWS-side suppression and sender DNS separately with administrative credentials; the sender needs only narrowly scoped SES sending rights.

Successful operations enqueue durable jobs and launch workflows after commit. The existing authenticated `/api/internal/repair` job repairs missed enqueues and abandoned launches. Its configured cron runs daily; normal sends launch immediately, but recovery during an outage may wait until the next repair run. For local email-only repair, run the exported `repairEmailJobs()` from `src/server/email/jobs.ts` in a script with the same environment and React server condition. Do not invoke the full repair endpoint solely for email testing: it also performs the existing GitHub synchronization.

The administrator page shows recent delivery jobs, attempts, bounded error codes, SES IDs, and feedback. `submitted` means SES API acceptance, not inbox delivery. A `sending` job whose lease expires becomes `outcome_unknown`, never automatically resendable. Confirmed throttling/preparation failures retry up to five attempts with exponential backoff. Review failures using job/SES IDs and SNS delivery logs; HTTP 500/503 feedback responses should be retried by SNS. Rejected messages cannot mutate delivery records.

Permanent bounces and complaints suppress the affected address independently of user preferences. Delivery, re-verification, and toggling preferences never clear suppression. Recovery is a manual operator procedure: verify the cause and mailbox owner's request, reconcile the SES suppression list with appropriate credentials, and only then remove that specific local suppression record. Unknown send outcomes require provider evidence before any operator-created replacement job; do not reset them to pending blindly.

Local live acceptance uses only simulator recipients and a loopback development database:

```bash
EMAIL_SIMULATOR_TEST=true node --env-file=.env --env-file=.env.local \
  --conditions=react-server --import tsx scripts/test-email-simulator.ts
```

This script sends through the application worker, waits for signed bounce/complaint feedback, checks SES-ID correlation and suppression, and proves later sends are skipped. It retains development fixtures as evidence. Use a fresh development database for repeat runs; it refuses to clear existing suppression or reuse simulator accounts. The tunnel and Next.js server must be running. No production verification bypass is installed, and these tests do not establish real-mailbox SPF/DKIM/DMARC or inbox placement.

The following acceptance scripts create and remove isolated schemas on the local database and make no external sends:

```bash
node --env-file=.env --env-file=.env.local --conditions=react-server --import tsx scripts/test-email-accounts.ts
node --env-file=.env --env-file=.env.local --conditions=react-server --import tsx scripts/test-email-jobs.ts
node --env-file=.env --env-file=.env.local --experimental-test-module-mocks --conditions=react-server --import tsx scripts/test-email-quota.ts
```

Run `npm run test:unit`, `npm run test:browser`, `npm run typecheck`, and `npm run build` for the full repository checks. On Node versions that report only file-level test counts, invoking each `tests/*.test.ts` directly with `node --experimental-test-module-mocks --conditions=react-server --import tsx <file>` exposes the individual assertion results.

### Project-local PostgreSQL

The development database on this machine is `ckocc_metro_dev` at `127.0.0.1:5433`, using the non-superuser role `ckocc_metro`. Its random password is stored in the ignored, owner-readable `.env.local`. PostgreSQL listens only on loopback; local administrator access uses operating-system peer authentication through the private project socket.

The data, socket, log, and recovery configuration are under ignored `.local/postgres/`. Data persists across stops and reboots. Start the server manually after a reboot; no system service was installed.

```sh
npm run db:local:status
npm run db:local:start
npm run db:local:stop
```

To initialize this development setup on another Linux machine with PostgreSQL binaries installed:

```sh
npm run db:local:init
npm run db:migrate
```

Initialization preserves existing project data and refuses to replace `.env.local` when it targets a different database. For a different port on the first initialization, set `METRO_DB_PORT`. This local database is for development; Vercel will need a separate hosted connection.

```sh
npm run typecheck
npm run build
```

These are compilation commands, not functional acceptance tests.

The owner reports that the npm tests and build passed. Local database setup also verified migration checksums, expected tables, application permissions, a transaction-scoped advisory lock, and a write/read/rollback. The current local acceptance checklist covers the main browser and integration journeys before deployment.

## Configuration

All variables are listed in [.env.example](.env.example). Generate independent strong random values for `BETTER_AUTH_SECRET`, `ABUSE_HASH_SECRET`, `GITHUB_WEBHOOK_SECRET`, and `CRON_SECRET`; the auth and abuse secrets require at least 32 characters.

| Configuration | Purpose |
| --- | --- |
| `APP_URL`, `BETTER_AUTH_URL` | Exact website origin, HTTPS in production; keep both equal. |
| `DATABASE_URL` | PostgreSQL URL with verified TLS. No schema is created by HTTP requests. |
| `GITHUB_APP_ID`, `GITHUB_INSTALLATION_ID`, `GITHUB_APP_PRIVATE_KEY` | Installation authentication. Store the full PEM with real newlines, or escaped `\n`. The OAuth client secret is unnecessary. |
| `GITHUB_OWNER`, `GITHUB_REPO`, `GITHUB_DEFAULT_BRANCH`, `GITHUB_BOT_LOGIN` | Fixed target and expected write identity for retry reconciliation. Confirm the bot login during staging. |
| `GITHUB_PERSONAL_ACCESS_TOKEN` | Optional alternative; set the expected login to the PAT's owner. If supplied, this takes precedence over App credentials. |
| `BLOB_READ_WRITE_TOKEN` | Token for a **private** staging store. |
| `PUBLISHED_BLOB_READ_WRITE_TOKEN` | Token for a separate **public** approved-image store. |
| `NEXT_PUBLIC_TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY`, `TURNSTILE_HOSTNAME` | Browser challenge and server verification, including expected hostname/action. |
| `TRUST_PROXY=vercel` | Enable Vercel's overwritten client-IP header when the platform also sets `VERCEL=1`. Local development uses one shared limiter bucket. |
| `CRON_SECRET` | Bearer secret for `/api/internal/repair`. `vercel.json` schedules daily repair; admins can retry/sync immediately in the UI. |

The old lowercase keys in the existing `.env` are retained as supplied. Runtime configuration uses uppercase names; the code does not discover PEM files automatically. Never expose server variables with a `NEXT_PUBLIC_` prefix. Never use production write credentials in preview deployments.

`/api/issues` needs the GitHub runtime settings above, even when PostgreSQL and login already work. Map metadata and saved update history do not wait for background reconciliation; when GitHub is configured, reads can schedule a status refresh after the response. Without public Blob storage, that refresh checks PR status but skips image publication. Uploading new files still requires private Blob storage, publishing new maps requires public Blob storage, and anonymous submissions require Turnstile.

## Map repository and safeguards

Map data lives separately in [ofts-cqm/ckocc-metro-map](https://github.com/ofts-cqm/ckocc-metro-map). The ignored `map-data/` checkout has its own Git history and remote:

```sh
git clone https://github.com/ofts-cqm/ckocc-metro-map.git map-data
```

Its authoritative paths are `maps/network.json`, `maps/network.png`, and `maps/manifest.json`. The website updates those three paths in one commit. Administrators can merge website-created map PRs through the GitHub merge API after review and validation. The public repository independently exposes its JSON even though the website's source-download endpoint requires a collaborator session.

[Data-repository validation templates](data-repository-template/README.md) are prepared for later administrator installation. They have not been pushed. Required checks and repository rules must be configured before accepting production map updates. The runtime bot needs only Contents, Issues, and Pull requests write access, plus Metadata and Checks read; do not give it merge bypass rights, Workflows, or Administration permissions.

Enable the GitHub App webhook at `/api/webhooks/github` after deployment, with Push, Pull request, Issues, and Issue comment events and the matching secret. The receiver validates signatures and source; durable tasks reconcile current default-branch state, retaining the previous publication on failure.

## Code layout

| Path | Responsibility |
| --- | --- |
| `src/app/[locale]`, `src/components`, `src/lib/i18n` | Public, collaborator, and admin pages; complete locale catalogs. |
| `src/lib/contracts.ts`, `src/lib/schemas.ts` | Shared API shapes and input validation. |
| `src/server/auth`, `src/server/security`, `src/server/db` | Invited accounts, Argon2id passwords, authorization, abuse controls, persistence. |
| `src/server/github`, `maps`, `storage`, `operations` | GitHub requests/PRs, validation, staging, idempotent jobs and publication. |
| `src/workflows` | Durable workflow entry points; steps receive operation IDs. |
| `migrations`, `scripts` | Explicit database setup and administrator bootstrap. |
| `public/maps` | Approved bootstrap metadata and a derived display overview. |

Keep environment files and private keys out of commits, screenshots, logs, and issue descriptions. Database backups must include account/workflow state; GitHub alone cannot restore website accounts.

## Administrator merge and rollback controls

On the Updates page, administrators can select **Merge PR**, review the map version, and confirm the merge. The review includes a live `validate-map` status widget, automatic refresh every 15 seconds while visible, and manual refresh. A failed refresh clears merge readiness. The server checks fresh administrator authentication (15 minutes), pins the approved PR head, validates its map files, and requires a successful GitHub Actions `validate-map` check. Drafts, conflicts, changed PR identities, stale map bases, and blocked repository rules cannot be merged. Failed or unknown operations remain visible in the existing administrator operation controls; retries reconcile GitHub before repeating uncertain writes.

**Create rollback PR** restores the complete JSON/PNG pair from before a selected website-created merge. The confirmation warns that merging it removes later map changes. A fresh manifest records the current default-branch base and the acting administrator. The new PR must pass the same merge checks. Resolved requests remain closed. Historical publication records stay historical; only the operation in the current publication manifest is labeled as the currently published map. Administrators see their own submissions under **My updates** and other creators' submissions under **Updates from others**, with submitter names and independent pagination of 10 per section. Updates start collapsed; expand a summary to see map versions, GitHub check status, and administrator controls. Merge and rollback controls are available in both sections.

Merge and rollback use the existing operations, outbox, and audit tables; no database migration is required. New routes are administrator-only `GET /api/admin/updates/[id]` for review and `POST /api/admin/updates/[id]/merge` or `/rollback`. POST requests require `Idempotency-Key`; both pin `baseCommit`, and merge additionally pins `headSha`. Responses return the existing operation receipt with HTTP 202. IDs refer to website operations, never arbitrary repository or PR identifiers.

### Enabling website merges

`WEBSITE_MERGES_ENABLED` defaults to disabled. Before setting it to `true`:

1. Install the reviewed validation workflow and scripts from `data-repository-template` with an administrator identity. Pin the checkout action to a verified release commit.
2. Require `validate-map` from GitHub Actions on the default branch and require branches to be up to date. The bot must not bypass these validation rules. Strict freshness is essential because GitHub's merge API pins the PR head but does not accept an expected default-branch SHA.
3. Permit the application to merge through PRs, enable merge commits, and remove any requirement for a separate GitHub review if website confirmation is to supply approval. Keep force pushes disabled. Keep Workflows and Administration permissions away from the application; add Checks read to its existing permissions.
4. Exercise two competing map PRs in the dedicated test repository: after one merges, the other must be rejected as stale. Exercise a historical rollback PR, duplicate confirmations, and publication recovery before enabling production.

Live acceptance on 2026-10-10 verified the installed workflow and active rulesets in `ofts-cqm/ckocc-metro-map-test`, using the website's GitHub App credentials, real operation workers, local PostgreSQL, and Blob storage:

- [PR #10](https://github.com/ofts-cqm/ckocc-metro-map-test/pull/10) passed `validate-map`, merged, and published. [Competing PR #11](https://github.com/ofts-cqm/ckocc-metro-map-test/pull/11) then failed with `stale_base_revision`; GitHub also rejected its merge with HTTP 405.
- [Invalid PR #12](https://github.com/ofts-cqm/ckocc-metro-map-test/pull/12) failed validation with `Expected an RMP v80 document`; GitHub rejected its merge with HTTP 405.
- [Rollback PR #13](https://github.com/ofts-cqm/ckocc-metro-map-test/pull/13) passed validation and restored the original JSON/PNG bytes and published revision. A simulated publication failure preserved the successful merge record; retry restored publication without another merge commit.
- Repeated merge and rollback confirmations with different idempotency keys returned the same respective operations.

The test exposed a GitHub ruleset compatibility issue: `mergeable_state` can remain `blocked` under restrict-updates rules even when the app may merge through PRs. Readiness now permits that state after checking the candidate and trusted validation result; GitHub's merge endpoint enforces branch rules and caller permissions. Nineteen focused server tests and typechecking passed after this fix.

These were worker-level live tests; hosted browser authentication and Vercel Workflow dispatch were not exercised. `WEBSITE_MERGES_ENABLED=true` was set only inside the test process. No production data or branch protections were changed. Pinning the checkout action to a verified release commit remains a setup step before production use.
