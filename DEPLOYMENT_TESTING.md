# Deployment and testing procedures

Use this guide to configure, operate, and test the website. The current repository is deployed, as confirmed by the owner on 2026-10-21; provisioning steps apply to new environments or resource changes. Record feature/test results in [TECHNICAL_SPEC.md](TECHNICAL_SPEC.md), which explains the implementation behind these procedures.

## Resources and configuration

| Resource             | What to provision and why                                                                                                                                                                       |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node.js / npm        | Node 22.18+ and the committed lockfile for reproducible local/operator commands.                                                                                                                |
| Vercel               | Node.js hosting, Blob integration, Workflows, and authenticated cron for the website and durable jobs. Check plan execution/memory/storage/transfer/scheduling allowances against real uploads. |
| PostgreSQL           | Hosted production database with verified TLS; pooled app URL and direct migration URL. Use a separate development database.                                                                     |
| GitHub               | Initialized data repository and narrowly scoped GitHub App installation for issues, map PRs, validation, and publication.                                                                       |
| Vercel Blob          | Separate **private** upload staging and **public** approved-image stores.                                                                                                                       |
| Cloudflare Turnstile | Site/secret keys allowing the website hostname for protected public submissions.                                                                                                                |
| Optional email       | Regional SES verified sender/domain, sending credentials, DNS access, and SNS Standard topic with HTTPS feedback subscription.                                                                  |

Copy `.env.example` to `.env.local` for development without overwriting existing secret configuration. Fill uppercase runtime names; lowercase legacy values are not discovered, and a PEM file is not loaded automatically. Keep real values in ignored files or deployment secrets. Next.js loads local environment files; ordinary operator npm commands load `.env` then `.env.local`, while exported shell variables take precedence. The email-only production migration command instead loads `.env.prod-migrations`.

| Environment variables                                                          | Set them for                                                                                                                                  |
| ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `APP_URL`, `BETTER_AUTH_URL`                                                   | The same exact website origin: `http://localhost:3000` locally, HTTPS in production. Use that URL in the browser so origin checks match.      |
| `BETTER_AUTH_SECRET`, `ABUSE_HASH_SECRET`                                      | Independent random secrets of at least 32 characters for sessions and abuse digests.                                                          |
| `DATABASE_URL`                                                                 | The environment's app database; use the provider's pooled connection where supported. Override with a direct URL for ordinary migrations.     |
| `GITHUB_APP_ID`, `GITHUB_INSTALLATION_ID`, `GITHUB_APP_PRIVATE_KEY`            | Installed App authentication; supply the full PEM with actual newlines or escaped `\n`. No OAuth client secret is needed.                     |
| `GITHUB_OWNER`, `GITHUB_REPO`, `GITHUB_DEFAULT_BRANCH`, `GITHUB_BOT_LOGIN`     | Fixed data target and exact bot identity used to reconcile writes.                                                                            |
| `GITHUB_WEBHOOK_SECRET`                                                        | Independent random secret matching the App webhook configuration.                                                                             |
| `GITHUB_PERSONAL_ACCESS_TOKEN`                                                 | Optional App alternative; when set, it takes precedence. Set the expected login to its owner and manage expiry/rotation.                      |
| `BLOB_READ_WRITE_TOKEN`, `PUBLISHED_BLOB_READ_WRITE_TOKEN`                     | Private staging token and separate public publication token, respectively.                                                                    |
| `NEXT_PUBLIC_TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY`, `TURNSTILE_HOSTNAME` | Public widget, server verification, and expected hostname.                                                                                    |
| `TRUST_PROXY=vercel`                                                           | Production IP verification; Vercel supplies `VERCEL=1`.                                                                                       |
| `CRON_SECRET`                                                                  | Independent random bearer secret for `/api/internal/repair`.                                                                                  |
| `WEBSITE_MERGES_ENABLED`                                                       | Defaults false; enable only after validating repository protections below.                                                                    |
| `NEW_REQUESTS_PER_HOUR`, `NEW_REQUESTS_PER_DAY`                                | Defaults 3 and 10 per IP.                                                                                                                     |
| `NEW_COMMENTS_PER_HOUR`, `NEW_COMMENTS_PER_DAY`                                | Defaults 10 and 30 per IP.                                                                                                                    |
| `GUEST_MENTIONS_PER_DAY`                                                       | Defaults 3 selected accounts per guest IP/day.                                                                                                |
| `DISABLE_RATE_LIMITS`                                                          | Temporary local/test bypass only; defaults false and cannot disable production limits.                                                        |
| `AWS_REGION`, `SES_FROM_EMAIL`, `SES_FEEDBACK_TOPIC_ARN`                       | Optional email region, verified sender, and exact accepted feedback topic.                                                                    |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`              | Only when required by the AWS SDK credential chain; prefer role credentials. Include the session token for temporary environment credentials. |
| `SES_REPLY_TO_EMAIL`                                                           | Optional monitored reply mailbox.                                                                                                             |
| `EMAIL_NOTIFICATIONS_ENABLED`                                                  | Defaults false; enable sending after email configuration and delivery checks.                                                                 |
| `EMAIL_NOTIFICATIONS_PER_DAY`                                                  | Defaults 5 notification emails/account/UTC day; positive integer.                                                                             |
| `EMAIL_TOKEN_SECRET`                                                           | Optional independent 32+ character signing secret; otherwise uses the auth secret. Keep stable across instances.                              |

Generate each independent secret with `openssl rand -hex 32`. Never expose server secrets with `NEXT_PUBLIC_`, commit them, or include them in screenshots/logs/issues. Restart local servers or redeploy after configuration changes. Preview/test resources must have their own database, repository, storage, challenge configuration, origins, and email topic/credentials; do not give previews production write credentials.

## Local development and database

```sh
npm ci
cp -n .env.example .env.local
```

Fill `.env.local` before using backend features. For a local database on Linux, install PostgreSQL binaries and run:

```sh
npm run db:local:init
npm run db:migrate
npm run admin:bootstrap
npm run dev
```

The helper defaults to `127.0.0.1:5433`, database `ckocc_metro_dev`, role `ckocc_metro`; it writes development credentials to ignored `.env.local`. Set `METRO_DB_PORT` on first initialization for a different port. It preserves existing data and refuses to replace an environment file targeting another database. Persistent files are under `.local/postgres/`; after reboot, start it manually:

```sh
npm run db:local:status
npm run db:local:start
npm run db:local:stop
```

For an externally provisioned development database, skip initialization and configure its URL. Migrations need a **direct** database URL because the lock spans transactions; ordinary app traffic can use pooling. For a one-off direct connection, set `DATABASE_URL` in your shell securely before running `npm run db:migrate`, then remove the override to restore app configuration.

Bootstrap runs in an interactive terminal, checks database prerequisites, and prompts for email, display name, and a hidden 8–128 character password. It refuses once an administrator exists. Administrators create invitations through the website; there is no public registration. Diagnose failures using the final sanitized message, never by sharing passwords or database URLs.

The approved bootstrap reference map is available before first publication. Login requires the origin/secrets/database; issue browsing additionally requires GitHub. New uploads need private Blob, publication needs public Blob, and public submissions need Turnstile. These dependencies explain why a rendering homepage alone is not an integration check.

## GitHub and map repository setup

1. Register a GitHub App under the data repository owner, disable unused OAuth/device flows, generate a private key, and install it on only the intended repository. Record App ID and installation ID separately.
2. Grant Contents, Issues, and Pull requests **write**, Metadata and Checks **read**. Keep Workflows/Administration permissions and validation bypass rights away from the runtime identity. Confirm its exact bot login.
3. Initialize the data repository's default branch with the approved `maps/network.json`, `maps/network.png`, and `maps/manifest.json`. Pre-create `metro-request`, `type:general`, `type:line-update`, `operation:add`, and `operation:update` labels. The production repository is [ofts-cqm/ckocc-metro-map](https://github.com/ofts-cqm/ckocc-metro-map); local acceptance uses `ofts-cqm/ckocc-metro-map-test`.
4. Install the reviewed workflow/validator using an administrator identity. For structurally compatible RMP exports of any version, install the updated `data-repository-template/scripts/validate_map.py` and `prepare_manifest.py` on the data repository default branch before deploying website support; it validates structure without a version allowlist and checks that the manifest editor version matches the JSON. Follow the [validation template instructions](data-repository-template/README.md), including pinning checkout to a verified release commit. Require trusted GitHub Actions `validate-map` and strict up-to-date branches, with no validation bypass. Disable force pushes.
5. Permit administrators and the application to merge through PRs; enable merge commits. If website confirmation supplies approval, do not also require a separate GitHub approval. Keep merger-identity permissions separate from the validation rules so identity access cannot bypass checks.
6. In App webhook settings, enable `https://<origin>/api/webhooks/github`, SSL verification, and Push, Pull request, Issues, and Issue comment events. Match `GITHUB_WEBHOOK_SECRET` and confirm delivery. Do not use a locale prefix or block provider callbacks behind interactive authentication.
7. Exercise competing PRs, invalid content, rollback, duplicate confirmations, and publication recovery against the test repository. Only then set `WEBSITE_MERGES_ENABLED=true` in the target environment.

The optional local data checkout is independent of website source:

```sh
git clone https://github.com/ofts-cqm/ckocc-metro-map.git map-data
```

Administrators should inspect summary/selected issues, compare PNGs, reopen JSON in the editor, and check concurrent edits before merging. To restore a historical map, use **Create rollback PR**, then separately review/merge it. For non-website history use the [manual rollback procedure](data-repository-template/README.md#preparing-a-rollback-manually). Do not restore an obsolete manifest with a plain revert. Decide separately whether to reopen resolved requests.

## Email setup and enablement

1. In the chosen SES region, verify the sender domain and publish Easy DKIM CNAME records. Review DMARC (start with monitoring while verifying legitimate senders). Optionally add a dedicated MAIL FROM subdomain with the regional MX and SPF TXT records. Preserve root-domain mailbox MX records. A sending address does not require a mailbox; use a real monitored mailbox for Reply-To if needed.
2. Configure AWS SDK credentials with only `ses:SendEmail` for the verified identity, restricted to the From address. Use administrative credentials separately for provisioning, DNS, and SES suppression management. See [SES identity setup](https://docs.aws.amazon.com/ses/latest/dg/creating-identities.html) and [SNS configuration](https://docs.aws.amazon.com/ses/latest/dg/configure-sns-notifications.html) for provider instructions.
3. Enable/check SES account suppression for bounces and complaints. Configure identity bounce/complaint notifications to the regional SNS Standard topic, with an SES publish policy scoped to the account/identity. Subscribe `https://<origin>/api/email/feedback` with raw delivery **disabled**. Confirm the subscription and exact `SES_FEEDBACK_TOPIC_ARN`; allow signed SNS callbacks through hosting access controls.
4. Apply migrations 003/004 before running the updated email paths. Keep sending disabled while preparing or repairing the environment. Existing users remain opted out until consent and mailbox verification.
5. Run the local email checks below. For a controlled real test recipient, verify content, links, SPF/DKIM/DMARC headers, and inbox placement. Simulator success does not establish those properties.
6. For arbitrary recipients, obtain SES production access in that region. Supply the real website URL, expected volume, consent process, and implemented bounce/complaint handling. Sandbox sends remain restricted to verified recipients and simulator addresses.
7. Confirm permanent SNS subscription, schema, HTTPS origin, and delivery checks, then enable `EMAIL_NOTIFICATIONS_ENABLED=true`. Monitor delivery failures, feedback, quota pressure, suppression, and SES reputation. Verify user opt-in/mailbox verification through Settings.

### Email-only production schema preparation

Use this for an existing database with baseline migrations 001/002. Configure its **direct**, provider-verified TLS connection as `PRODUCTION_DATABASE_URL` in the shell or ignored `.env.prod-migrations`. Do not put the real URL in documentation or command history.

```sh
npm run db:migrate:email:prod -- --check
npm run db:migrate:email:prod
npm run db:migrate:email:prod -- --check
```

The first/last commands inspect prerequisites/checksums and pending migrations without schema changes. The middle command applies only 003/004, preparing email tables/cutoff/quota without deploying or sending. It loads neither `.env` nor `.env.local` and never falls back to `DATABASE_URL`. It skips already-applied migrations; rerun after correcting a failure. Full new-environment provisioning instead uses the ordinary migration command with a securely supplied direct URL.

## Deployment and routine updates

1. Confirm the target environment's repository, database, stores, origin, and secrets. Back up database account/workflow state before schema changes. Apply required new migrations with a direct connection; never edit an applied migration.
2. Run repository checks below, then deploy with the committed lockfile and Node runtime. Configure the hosting app's pooled database URL and all required environment variables.
3. For first-time setup, bootstrap the administrator interactively against the intended database, install repository protections, and configure webhooks/callbacks. Preserve an existing deployed administrator on routine updates.
4. Verify `CRON_SECRET` and the `/api/internal/repair` schedule from `vercel.json` (04:23 UTC daily). Normal jobs launch immediately; use administrator retry/sync for recovery that cannot wait for the next sweep.
5. Check the public HTTPS origin/session cookies, database access, one controlled upload and signed callback, GitHub webhook, Workflow dispatch/completion/publication, and repair authentication. Confirm native Argon2/sharp behavior with the real map and check runtime memory/duration/plan limits.
6. Record dated results and limitations beside the affected specification. Gate email/website merges on their configuration checks rather than assuming deployment enables them.

## Testing

Primary functional acceptance runs locally against the dedicated test repository, development PostgreSQL, and separate Blob/Turnstile resources, followed by the brief hosted checks above. This replaces the original proposal for a separate staging acceptance environment.

### Repository checks

```sh
npm run test:unit
python3 tests/map_validator_test.py
npm run test:browser
npm run typecheck
npm run build
git diff --check
```

Playwright starts/reuses the local development server on `http://localhost:3000` and retains failure traces. Install its browser runtime if absent (`npx playwright install chromium`). Review the environment before integration runs. Typecheck/build prove compilation, not provider permissions or functional acceptance. If Node reports only file-level unit counts, run a test file directly with `node --experimental-test-module-mocks --conditions=react-server --import tsx tests/<name>.test.ts` for its individual results.

For gallery changes, run `npm run test:browser -- tests/browser/gallery.spec.ts`. This uses mocked APIs and real local photo assets to check rotation, controls, reduced motion, locale navigation, image loading, and mobile layout. Inspect the homepage carousel and full gallery on desktop and mobile. To extend the collection, add matching 640- and 1600-pixel-wide WebP files in `public/gallery` and localized captions/order in `src/lib/gallery.ts`; the runtime does not read the sibling source folder. After deployment, check a homepage photo link and the gallery images in each locale.

### Local PostgreSQL update recovery acceptance

Run against the existing local development database. The script refuses remote/non-development connections, creates an isolated schema, and removes it afterward; it makes no GitHub or Blob writes.

```sh
npm run db:local:start
node --env-file=.env.local --experimental-test-module-mocks --conditions=react-server --import tsx scripts/test-update-recovery.ts
```

It also reproduces uncertain maintenance blocking close: six concurrent reconciliations must record one success/audit and unblock close only when the branch reference matches the planned commit. Changed/unavailable evidence, live leases, racing retries/source changes, and revoked authorization must preserve the blocker. GitHub reads are mocked and no mutation methods are exposed.

Terminal-action checks cover obsolete merge/close/edit/maintenance attempts after confirmed PR closure/merge: one reconciliation/audit across concurrent scans, retained previous errors, stopped outbox/retry/leases, and a new merge request independent of a superseded attempt. Unknown writes, publication failures, live leases, unavailable/mismatched evidence, and racing retries must remain unresolved.

This also checks administrator recovery of another contributor's update, concurrent deletion/audit/history removal and retry protection, and serialization of six concurrent PR-action submissions. It checks six concurrent recovery requests return one pinned draft and audit, preserve the failed record, block its old retry/worker lease, and expose history recovery only while the replacement remains editable. Unit/browser checks cover file validation, authorization, and the editable form; hosted upload callbacks and PR creation still require provider acceptance.

### Local PostgreSQL upload-quota acceptance

```sh
node --env-file=.env.local --experimental-test-module-mocks --conditions=react-server --import tsx scripts/test-upload-quota.ts
```

This refuses remote/non-development connections and uses a temporary schema that is removed afterward. It verifies actual-size charging for ready uploads, maximum pending reservations, missing-size fallback, deleted exclusion, account/global limits, and concurrent reservations. No Blob objects are written or deleted. `storage_quota_exceeded` on `/api/uploads/reserve` is a byte quota, not a request rate limit; `DISABLE_RATE_LIMITS` does not bypass it. Expired retained uploads count until cleanup confirms deletion. Use normal administrator maintenance for cleanup; do not reset quota counters or erase failed/uncertain operation assets.

### Automatic maintenance catch-up acceptance

Keep the trusted `validate-map` check, strict up-to-date requirement, and separate merge-access rules enabled. Deploy the website changes with the existing runtime App permissions; no migration, new environment variable, Workflows access, or Administration access is required. Pending matching-map PRs catch up through ordinary webhook/read reconciliation or when an administrator opens **Merge PR** review. Wait for fresh validation and then explicitly review/confirm the merge. If the approved map changed, reconcile it in RMP and submit a reviewed update instead.

```sh
node --env-file=.env.local --experimental-test-module-mocks --conditions=react-server --import tsx scripts/test-map-maintenance.ts
```

This uses and removes an isolated local test schema, with workflow launching stubbed. It checks concurrent deduplication, the outbox, uncertainty preservation, and background eligibility without GitHub writes.

For explicit live acceptance on `ofts-cqm/ckocc-metro-map-test` with the runtime App and local test database:

```sh
node --env-file=.env.local --experimental-test-module-mocks --conditions=react-server --import tsx scripts/test-map-maintenance-live.mts --live
```

The live script refuses production repository/database targets and PAT authentication, creates one disposable draft PR from approved pre-maintenance history, exercises the real catch-up worker, verifies exact map bytes and fresh trusted checks, and closes/deletes its own draft/branch. It never merges or updates `main`. It needs an existing maintenance-only interval in test history. Results with safe IDs and checkpoints are saved to `/tmp/ckocc-maintenance-live.json`. After an interrupted run, inspect that report and reconcile before repeating any write; close only the test's own draft/branch. A failed cleanup or missing report needs manual lookup first.

On deployment, verify existing pending PR catch-up from a default-branch maintenance push, fresh checks, and visible status transitions. Before accepting **Close without merge**, the portal attempts read-only reconciliation of uncertain maintenance against the recorded planned commit. If GitHub confirms completion, it records the result and proceeds; otherwise the action remains blocked. For other `outcome_unknown` cases, use administrator operation diagnostics/retry only to reconcile the recorded ref; do not clear checkpoints. GitHub's merge UI may require an allowed administrator to explicitly use the PR-only permission in **Map merge access**; the independent validation rules must remain enforced.

When the administration page shows an old PR action after its update has ended, loading **Operations needing attention** now checks eligible failed attempts against GitHub. Normal PR synchronization runs the same reconciliation. Confirmed obsolete attempts become **No longer needed** (`superseded`); their checkpoint retains the previous error and their pipeline audit records `supersede-terminal-pr-action`. Refresh after synchronization if the parent update was still stale. A provider outage, reopened PR, live lease, uncertain write, or unresolved publication can legitimately keep an alert visible; inspect its recorded outcome rather than clearing it manually. This requires the updated website code, with no database migration.

### Manual operation reconciliation

Preview every operation in the production database, using the connection from `.env.prod-migrations`:

```sh
npm run ops:reconcile -- --prod --repository ofts-cqm/ckocc-metro-map --github-env .env.local
```

Review the proposed changes, then append `--apply` to that command to record them. Production mode requires `PRODUCTION_DATABASE_URL` (shell or `.env.prod-migrations`) and never falls back to `DATABASE_URL`. `--github-env` imports only GitHub credentials and bot identity, never its database or repository target; choose a file whose App installation can read the selected repository, or omit it when those variables are already exported. `--repository` is required; `--branch` defaults to `main`. For an isolated development database, omit `--prod` and supply `DATABASE_URL` in the shell.

The default preview enforces a read-only database connection. The scan is paginated across all operations. Apply retires deleted pre-write failed uploads, synchronizes confirmed terminal PR state, and supersedes obsolete pre-write PR actions. Each change locks and rechecks the recorded rows, retains the previous error, completes the outbox, and inserts `manual-reconcile-operation` in the pipeline audit. Reruns are safe; concurrent changes are skipped. No GitHub content, map publication, workflow, or email writes occur. This is not a blanket retry: uncertain writes, failed discussion/sync operations, and publication recovery still require their specific recovery paths. Missing evidence remains unresolved. Exit status `2` means unresolved records or racing changes; `1` means command/configuration failure. Safe JSON output contains operation IDs and reasons, not payloads or credentials.

Local acceptance uses an isolated schema and mocked provider reads:

```sh
node --env-file=.env.local --conditions=react-server --import tsx scripts/test-manual-reconciliation.ts
```

### Local PostgreSQL email acceptance

Use only a loopback development/test database. These scripts create/remove isolated schemas and do not send external mail:

```sh
node --env-file=.env --env-file=.env.local --conditions=react-server --import tsx scripts/test-email-accounts.ts
node --env-file=.env --env-file=.env.local --conditions=react-server --import tsx scripts/test-email-jobs.ts
node --env-file=.env --env-file=.env.local --experimental-test-module-mocks --conditions=react-server --import tsx scripts/test-email-quota.ts
node --env-file=.env --env-file=.env.local --import tsx scripts/test-email-migrations.ts
```

### Live SES simulator acceptance

Use a fresh loopback development database and development AWS topic/credentials. Start the app and an HTTPS tunnel:

```sh
cloudflared tunnel --url http://localhost:3000
```

Subscribe `https://<temporary-host>/api/email/feedback` to the development topic with raw delivery disabled; confirm it and keep the tunnel/app running. Configure email sending for the development environment, then run:

```sh
EMAIL_SIMULATOR_TEST=true node --env-file=.env --env-file=.env.local \
  --conditions=react-server --import tsx scripts/test-email-simulator.ts
```

This sends real messages through the application worker to `success@simulator.amazonses.com`, `bounce@simulator.amazonses.com`, and `complaint@simulator.amazonses.com`. It checks signed feedback, SES-ID correlation, local suppression, and later skipped sends. It retains fixtures and refuses existing simulator addresses/suppressions; use fresh development data for repeat runs. Do not add a production verification bypass or expect simulator addresses on SES's real suppression list. Remove stale tunnel subscriptions after testing.

### Functional acceptance checklist

Record each result/fix in the relevant technical-spec testing notes, and rerun affected checks after fixes.

- **Accounts:** login/logout, invitations and concurrent redemption, password reset/disabled-session revocation, account-name enforcement, guest name protection, fresh-admin and role boundaries, public-signup rejection.
- **Requests/discussion:** real challenge success/rejection, general and line requests, Chinese text, missing optional names, string line numbers, custom/default dimensions, integer coordinates, comments/replies/mentions, guest quota, chronological pagination, closed/locked/unlabeled rejection, safe Markdown and explicit issue closing.
- **Uploads/maps:** actual JSON/PNG pair, pinned source, private/public storage access, preview/draft recovery on reload/locale changes/expired sessions, corrupt/oversized files, ownership checks, editor reopening and JSON/PNG visual correspondence.
- **Update management:** expand an open update PR as an administrator and verify **Close without merge** and **Edit update**; collaborators must not see these controls. Edit another contributor's PR, download its submitted source, upload replacement JSON/PNG, and save: verify the same PR number, original contributor/base, changed title/body/files, new validation checks, and merge blocked until the new head passes. Test stale-head/base rejection for edits and merges, demoted/disabled queued administrators, and close cancellation/completion even when commits/descriptions/branches changed or validation failed, and lost-response reconciliation without duplicate writes. Delete an own inactive update as a collaborator and another user's as an administrator; verify active/reopened PRs, live leases and uncertain actions block deletion. Confirm deletion hides history while preserving publication/GitHub/audit records. Use isolated development resources for live GitHub/Blob acceptance before hosted deployment.
- **Upload validation/recovery:** choose malformed JSON, invalid version metadata, and a corrupt PNG; each must fail before becoming a ready asset or accepting a submission. Confirm valid v80/v81 and future-version fixtures work, while future-version files with broken graphs fail. On a failed update without external writes, **Try again** in the receipt panel and **Edit and resubmit** in expanded **My updates** history must restore the original base/text/issue selection into an editable draft, require file selection, survive reload, and prevent retry of the replaced operation. Also test history recovery in a fresh tab without a saved receipt, confirmation before replacing a current draft, and retry after an API failure. Uncertain/written operations must remain blocked from this recovery.
- **GitHub/recovery:** one issue/comment/PR under duplicate or concurrent requests and interrupted workers; exact fixed paths and selected issue links; last-good map until merge; unmerged closure; two competing edits; stale rejection even after Update branch; invalid PR blocked; historical rollback; duplicate confirmations; publication retry without another merge.
- **Publication/security:** valid/invalid/duplicate/missed/out-of-order webhooks, authenticated repair, trusted proxy limits, same-origin checks, durable jobs/outbox, safe diagnostic errors and logs.
- **Inbox/email:** reply/mention/admin recipient rules, self exclusion, persisted reads, consent/verification/address changes, queued invalidation, daily-cap concurrency/UTC rollover/retry reservations, invalid and early/out-of-order SNS feedback, suppression persistence, transient versus ambiguous send handling, inbox unaffected by email failure.
- **Interface:** all three locales, Hong Kong wording, narrow mobile layout, keyboard/touch map controls, upload progress/errors, longer labels, draft/station order preservation across language switches, and real map legibility.

## Recovery and maintenance

Use administrator operation diagnostics and retry/sync controls with operation IDs. Reconcile uncertain GitHub writes before retrying; investigate email jobs with job/SES IDs and SNS logs. `submitted` is API acceptance, not inbox delivery. An uncertain email outcome requires provider evidence before creating a replacement; never blindly reset it to pending.

For email-only local recovery, call exported `repairEmailJobs()` from `src/server/email/jobs.ts` in a script with the same environment and `--conditions=react-server`. The full repair endpoint also synchronizes GitHub, so use it only when that wider action is intended. SNS should retry temporary HTTP 500/503 responses; investigate persistent feedback failures.

For suppressed addresses, verify the cause and mailbox owner's request, reconcile SES suppression with administrative credentials, then remove only the reviewed local suppression record. Successful delivery, verification, or toggling preferences must not clear suppression automatically.

Back up PostgreSQL, rotate compromised credentials, revoke departed collaborators, and monitor failed/pending jobs, last sync/publication, authentication/upload failures, and quotas. Protect backup credentials and token-bearing links just like runtime secrets.
