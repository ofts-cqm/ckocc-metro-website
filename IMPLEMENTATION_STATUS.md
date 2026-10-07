# Implementation handoff — 6 October 2026

The owner authorized implementation using subagents and asked to do deployment and testing after returning. This record distinguishes code written from behavior still requiring acceptance. No deployment, database migration, administrator provisioning, live submission, or browser/test-suite execution occurred during website implementation.

## Current testing decision — 6 October 2026

The owner expects at most five collaborators and roughly twenty participants, and chose to skip a separate staging environment. The primary acceptance run will use the local website, local PostgreSQL, the GitHub App installed on `ofts-cqm/ckocc-metro-map-test`, and the configured Blob/Turnstile services. This decision supersedes the staging requirements in the original plan and historical checklist below. After deployment, perform a short check of behavior that depends on Vercel and the public origin.

### Local acceptance run

Record the result and any fix for each journey; rerun affected checks after fixes.

1. **Accounts:** administrator login/logout, eight-character password, collaborator invitation/redemption, reset and disabled-account session revocation; anonymous users and collaborators cannot access administrator actions.
2. **Requests and comments:** general request, line update, and discussion reply arrive in the test repository; verify Turnstile and a rejected challenge. Include an omitted English name, string line number, default/custom dimension, Chinese text, and coordinate validation.
3. **Uploads:** download the current source, upload the real JSON/PNG pair, reload and recover the draft/preview; reject wrong file types, invalid map data, and another account's upload reference. Check both Blob stores' access behavior.
4. **PR and publication:** submit once, confirm the expected three files and issue links, keep the approved map until manual merge, then synchronize and verify the new image/revision and issue closure. Closing an unmerged PR must preserve the current map.
5. **Concurrent edits:** create two drafts from one revision; merge the first and confirm the second needs reconciliation instead of overwriting the newer map.
6. **Recovery:** duplicate submission/retry must not create duplicate issues or PRs; exercise one interrupted or failed job and the admin retry/synchronize controls.
7. **Interface:** inspect all three locales, one narrow mobile viewport, map pan/zoom, validation messages, and language changes with an in-progress draft.
8. **Final code checks:** run the existing unit suite, type checking, and production build once the functional fixes are complete.

### Brief check after deployment

Verify the production origin and HTTPS session cookies, hosted database access, one real upload and its signed callback, GitHub webhook delivery, workflow completion/publication, and repair-job authentication. Review the configured repository and store targets before changing from test resources to production resources.

### Connection verification before local acceptance

- PostgreSQL reads and writes work; the verification transaction was rolled back and both migrations are present.
- The GitHub App can read issues, PRs, and all three map files in `ofts-cqm/ckocc-metro-map-test`. The imported map pair passes validation. The installation grants Contents/Issues/Pull requests write and Metadata read. The five required labels were missing and have now been created in the test repository.
- Both Blob stores accepted a small upload and returned identical content. The private object rejected an unauthenticated read with 403; the public object was readable without a token. Both temporary objects were deleted.
- The application's real Workflow initially failed first publication because it compared a Blob error's `name` with `BlobNotFoundError`; this SDK uses the inherited `Error` name. The code now checks the exported error class. Workflow retry succeeded, the test repository's publication is stored in PostgreSQL, and the published overview returned HTTP 200. Type checking passed after the fix.
- Cloudflare's widget script and Siteverify endpoint are reachable, and Siteverify rejects an invalid challenge without rejecting the configured secret. The local request page and widget render in an isolated browser, but its automated challenge did not complete; normal-browser confirmation is pending. No request was submitted by this connection check.
- GitHub webhook, Blob callback tunnel, and repair-job secrets are not yet configured. Manual synchronization and the application's direct upload-completion verification are available for local testing.

## Subsequent local database setup

The owner subsequently reported that npm tests and the build passed, then explicitly requested a **local development database**. PostgreSQL 18.6 is now configured at `127.0.0.1:5433`, database `ckocc_metro_dev`, application role `ckocc_metro`. The role has no superuser, database-creation, role-creation, or replication privileges.

Both existing migrations were applied. Verification confirmed all 18 expected tables, recorded migration hashes, UTF-8 encoding, loopback-only listening, transaction advisory locks, and a write/read/rollback that retained no test rows. The database contains no website accounts; administrator bootstrap remains a separate interactive step.

Credentials are saved in ignored `.env.local` with mode 0600. The ignored `.local/postgres/` directory contains persistent data and private connection recovery state. Use `npm run db:local:start`, `db:local:stop`, and `db:local:status`; the database does not automatically start after reboot. `npm run db:local:init` can recreate the setup on another Linux machine with PostgreSQL installed. Hosted database provisioning and Vercel deployment remain pending.

## Implemented areas

- **Accounts and abuse controls:** Better Auth credential sessions, salted Argon2id hashes, administrator bootstrap, email-bound single-use invitation/reset links, account disabling/session revocation, roles, fresh admin authentication, PostgreSQL rate counters, Turnstile, same-origin enforcement, and a public-write pause.
- **Requests and discussions:** General and ordered line-update forms, free-text dimensions defaulting to `overworld`, optional English names and line identifiers, string line numbers, GitHub issue/comment templates, eligibility checks, pagination, durable operation receipts, and safe display of Markdown.
- **Map updates:** Server-recorded edit bases, private direct uploads, RMP v80 and PNG validation, fixed-path atomic Git commit, PR creation with selected issue links, stale-base rejection, workflow checkpoints, an outbox, and explicit uncertain-outcome recovery.
- **Publication and operations:** Signed webhook ingestion, default-branch reconciliation, immutable original/overview publication, database publication locking, last-good map retention, admin retry/sync, and daily repair/cleanup.
- **Interface:** Three locales, language preference, map pan/zoom/touch controls, request/comment pages, invitation/login forms, collaborator submissions, and admin screens.
- **Repository handoff:** Pinned dependencies, SQL migrations, environment example, bootstrap map preview, and data-repository CI templates for later installation.

Three subagents owned accounts/data, GitHub/workflows, and multilingual UI. The main agent integrated shared schemas, application configuration, dependencies, and operator documentation.

## Compilation evidence

`npm run typecheck` and `npm run build` completed successfully, including the production webpack bundle, generated Workflow routes, Next.js route type validation, and page-data/build tracing. The Python operator scripts passed syntax parsing. Passing compilation does not establish authentication, GitHub, upload, webhook, mobile, or translation acceptance.

Focused unit tests under `tests/` cover input constraints, password primitives, map bytes/graph/PNG validation, and GitHub text templates. `npm run test:unit` is prepared for the next session and has not been executed. Database/provider concurrency and browser acceptance still need integration coverage.

## Resume with these steps

1. Choose development/staging service resources and hosting plan. Keep staging PostgreSQL, GitHub repository/App installation, Blob stores, challenge keys, and origins separate from production.
2. Review `.env.example`; configure uppercase runtime variables securely. Confirm the bot's exact login. Configure the private and public Blob stores separately.
3. Use the direct PostgreSQL URL to run migrations, then interactively bootstrap the initial administrator. Return the app to its pooled URL. Back up account and operation state.
4. Install/review the map-repository workflow and validator using an administrator identity. Pin action versions, configure branch rules, and verify the trusted validation check really blocks stale PRs. No bot bypass.
5. Exercise the application locally or in staging, then configure the App webhook and repair schedule. Validate the platform's trusted IP header, native Argon2/sharp runtime, Workflow retries, Blob callbacks, execution duration/memory, and plan quotas.
6. Complete the functional cases in [the design's acceptance list](IMPLEMENTATION_PLAN.md#acceptance-tests), then let the owner review the running UI before production deployment.

## Priority acceptance cases (not yet run)

- Login, invitation and reset races; two equal passwords produce distinct salted hashes; disabled/reset users lose existing sessions and upload access; anonymous/signup/role bypasses fail.
- All forms in all three locales, including Hong Kong wording and layout; optional English names, Chinese fallback, string line numbers (`01`, `2A`, `7.5`), custom dimensions (`server:moon`, `Resource World`, `資源界`), and default `overworld` survive round trips.
- Draft and staged upload recovery across locale changes, reloads, slow/error responses, and expired sessions. Desktop keyboard/touch map controls and mobile readability.
- Real challenge validation, durable limits, same-origin checks, field errors, script/Markdown injection, notification/closing-directive suppression, locked/closed/unlabeled issue handling, and pagination.
- The existing 7.36 MB PNG uploads directly to private storage; corruption, excessive decoded pixels, and unauthorized object references fail before writes. Original bytes and manifest hashes agree.
- Issue/comment/PR creation succeeds once under duplicate requests, concurrent workers, dropped responses, process restarts, and provider throttling. Unknown outcomes preserve checkpoints for recovery.
- Concurrent edits from A: first merge publishes B; second PR based on A cannot overwrite B even after GitHub's Update branch. Owner manually reconciles in the editor.
- Selected issues remain open until the correct PR merges; unmerged PR closure publishes nothing. Invalid, duplicated, missed, and out-of-order webhooks retain correct publication state.
- Actual data-repository CI, required checks, bot permissions, and administrator-only merge rules. A restored old map pair with a fresh manifest passes the rollback workflow; reopening issues remains an explicit administrator decision.

## Operational limits to review

The current map is 17,577 × 9,095 pixels. The viewer initially loads a reduced overview and offers the original separately. Deep zoom currently enlarges that overview; if station labels need to remain sharp inside the viewer at high zoom on phones, add image tiles after visual review.

JSON uploads are capped at 2 MiB; PNGs at 20 MiB, 24,576 pixels per axis, and 200 million decoded pixels. Staging reserves at most 128 MiB per collaborator and 1 GiB globally. Expired unused staging is cleaned, while assets needed for uncertain/failed operations are retained for recovery.

Invitations expire after 24 hours and reset links after one hour. Passwords allow 8–128 characters following the owner's change. Sessions last seven days, with 15-minute freshness required for administrative mutations. Argon2id begins at 19 MiB/two iterations/parallelism one.

The included repair schedule runs daily. Normal jobs launch immediately; an interrupted launcher can require manual admin recovery before the next daily sweep. More frequent scheduled repair depends on the selected Vercel plan. No cost or production-readiness claim is made before staging acceptance.
