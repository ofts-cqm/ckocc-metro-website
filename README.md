# CKOCC Metro

A metro map and request portal for the Minecraft server, built with Next.js, PostgreSQL, Better Auth, GitHub App installation authentication, Vercel Blob, and Vercel Workflow.

Players submit requests and comments without an account. Invited collaborators upload a Rail Map Painter JSON/PNG pair and submit a PR. An administrator reviews and merges in GitHub. The website publishes approved map revisions.

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

Bootstrap checks database access before requesting a password. Failures identify the affected step and provide specific guidance for invalid inputs, mismatched passwords, existing accounts, connection failures, and missing migrations; raw provider errors and credentials are never printed. Passwords must contain 8–128 characters, including any spaces. If the command fails, share only its final error message, never your password or `DATABASE_URL`.

Website login also needs `APP_URL`, `BETTER_AUTH_URL`, `BETTER_AUTH_SECRET`, and `ABUSE_HASH_SECRET` in `.env.local`; database setup and administrator bootstrap alone do not configure login. For local development, use `http://localhost:3000` for both URLs and generate independent random secrets of at least 32 characters. Restart `npm run dev` after changing environment variables. Open the site using the configured URL so login's origin check matches.

For temporary local testing, set `DISABLE_RATE_LIMITS=true` in `.env.local`. This skips application rate limits in development/test; production always enforces them. Set it back to `false` (or remove it) to restore limits. Restart the development server after changing it. Authentication, Turnstile, and the public-submission pause still apply.

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

Its authoritative paths are `maps/network.json`, `maps/network.png`, and `maps/manifest.json`. The website updates those three paths in one commit. It never calls a merge API. The public repository independently exposes its JSON even though the website's source-download endpoint requires a collaborator session.

[Data-repository validation templates](data-repository-template/README.md) are prepared for later administrator installation. They have not been pushed. Required checks and repository rules must be configured before accepting production map updates. The runtime bot needs only Contents, Issues, and Pull requests write access, plus Metadata read; do not give it merge bypass rights, Workflows, or Administration permissions.

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
