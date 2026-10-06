# CKOCC Metro

A metro map and request portal for the Minecraft server, built with Next.js, PostgreSQL, Better Auth, GitHub App installation authentication, Vercel Blob, and Vercel Workflow.

Players submit requests and comments without an account. Invited collaborators upload a Rail Map Painter JSON/PNG pair and submit a PR. An administrator reviews and merges in GitHub. The website publishes approved map revisions.

The interface supports `/en-us`, `/zh-cn`, and `/zh-hk`. Station dimensions accept arbitrary text and default to `overworld`; English names and line identifiers are optional, and line numbers are strings.

## Current handoff

Implementation is in this workspace. **Deployment and functional testing are deferred at the owner's request.** See [implementation status and next-session checklist](IMPLEMENTATION_STATUS.md) and the [agreed design](IMPLEMENTATION_PLAN.md).

## Local development

Use Node.js 22.18 or later and npm. Dependency versions are pinned in `package-lock.json`.

```sh
npm ci
npm run dev
```

Without backend configuration, the home page uses the real, approved bootstrap map and indicates that requests are unavailable. It does not fabricate discussion or account data. The small local overview avoids loading the 160-million-pixel original on initial display; the original remains available through the full-detail link.

For backend work, copy `.env.example` to **`.env.local`**, leaving the existing secret `.env` and PEM intact. Fill the documented variables using separate development resources. Next.js loads these files; the operator commands load `.env` then `.env.local`. Environment variables already exported in the shell take precedence.

After provisioning a development PostgreSQL database, these commands apply schema changes and create the first administrator. They have **not** been run in this implementation session:

```sh
npm run db:migrate
npm run admin:bootstrap
```

Bootstrap prompts for email, display name, and a hidden password in an interactive terminal. It refuses if an administrator already exists. Admins then create invitations through the website. There is no public registration or public bootstrap route. Migration checksums are recorded; add a new migration after deployment instead of editing an applied file. Use a direct database connection for migrations because their advisory lock is session-scoped; the app's normal `DATABASE_URL` can use transaction pooling.

```sh
npm run typecheck
npm run build
```

These are compilation commands, not functional acceptance tests.

Focused unit tests have been authored for the next session but have not been executed. Run `npm run test:unit` when resuming testing; database, browser, and staging integration cases remain in the acceptance checklist.

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
