# Contributor guidance

## Purpose

CKOCC is a Minecraft SMP server. Its Ministry of Railways has built metro systems since 2024. This website centralizes requests, line updates, discussion, and maintenance that became difficult to coordinate in a growing group chat. Keep player participation simple and administrator review explicit.

## Documentation ownership

- `README.md` is for visitors: project introduction and user-facing features only.
- `TECHNICAL_SPEC.md` is the canonical design/plan and evidence record. For each behavior, put the specification first, then implementation status (planned/implemented/tested), then dated testing notes and limitations. Update these together when behavior changes; distinguish code, deployment, and actual test evidence.
- `DEPLOYMENT_TESTING.md` contains concise operator instructions: what to do, how, and why. Keep technical explanations in the spec and environment names/defaults aligned with `.env.example`.
- Keep this file short and always applicable; link detailed or feature-specific guidance instead of duplicating it. Do not recreate separate implementation-plan/status or email-spec documents.

The owner confirmed on 2026-10-21 that the current repository was the latest deployed version. Preserve dated evidence without treating that deployment baseline as proof of every hosted acceptance scenario.

## Implementation constraints

- Collaborator/admin accounts are administrator-invited or explicitly promoted; public registration is limited to email-verified subscribers. No public bootstrap. Enforce active account, role, and required fresh authentication on the server, including queued mutations and uploads.
- Signed-in in-game names come from the account, are visibly disabled in forms, and cannot be overridden through APIs. Protect collaborator/admin names from guest/subscriber impersonation; subscriber names remain unverified and do not reserve names against guests. Website attribution does not prove Minecraft identity ownership.
- Preserve public participation controls and consistent replies/mentions for both comments and general thoughts. Keep chronological paginated comments. Line numbers are strings; English station names/line identifiers are optional; dimensions are free text defaulting to `overworld`.
- Preserve original RMP JSON/PNG bytes and commit them with the manifest atomically at the three fixed map paths. Record edit bases, reject stale changes, and require human reconciliation/review; never relabel an unknown export as current or automatically merge whole map documents.
- Keep required trusted map validation and branch freshness effective without runtime-bot bypass. Runtime credentials must not gain Workflows/Administration access. Publishing follows approved default-branch state and preserves the last good map on failure.
- Persist intent/outbox/checkpoints around external writes. Reconcile uncertain responses before another write; preserve `outcome_unknown` when evidence is inconclusive. Email suppression and uncertainty must not be cleared by automatic retry or preference changes.
- Applied migrations are immutable: add a new migration. Use a direct connection for migration locks. Inbox markers/payloads and email persistence have different roles; consult the spec before changing the data model.
- Keep development/test/preview resources separate from production writes. Never commit/log environment secrets, keys, receipt/invite/reset tokens, private storage URLs, or raw IPs. Use narrow credentials and safe operation IDs for diagnosis.

## Verification

Use checks proportionate to the change and record their actual limits. For runtime work, use [the testing procedures](DEPLOYMENT_TESTING.md#testing): unit/browser checks, typecheck/build, and relevant integration/provider acceptance. Mocks and compilation cannot prove hosted behavior; visual claims require actual UI inspection. Run `git diff --check` after edits. Documentation-only changes need link/command/source consistency checks, not provider writes or migrations.
