import "server-only";
import { transaction } from "@/server/db";
import { AppError } from "@/server/http";
import { lockIdentityStore } from "./credentials";
import { audit } from "./invitations";

/** Called only after same-origin, fresh-admin and target-specific confirmation checks.
 * No provider writes: completed shared work and delivery evidence remain detached. */
export async function deleteAccount(actorId: string, targetId: string) {
  if (actorId === targetId)
    throw new AppError(
      "cannot_delete_self",
      "Ask another administrator to delete your account.",
      409,
    );
  return transaction(async (client) => {
    await lockIdentityStore(client);
    const actor = await client.query(
      "SELECT 1 FROM metro_profiles WHERE user_id=$1 AND role='admin' AND active",
      [actorId],
    );
    if (!actor.rowCount)
      throw new AppError("forbidden", "Administrator access is required.", 403);
    const target = await client.query<{
      email: string;
      role: string;
      active: boolean;
    }>(
      `SELECT u.email,p.role,p.active FROM "user" u JOIN metro_profiles p ON p.user_id=u.id WHERE u.id=$1 FOR UPDATE OF u,p`,
      [targetId],
    );
    // Retrying a confirmed deletion cannot affect a replacement account with a new ID.
    if (!target.rowCount) return;
    const user = target.rows[0];
    if (user.role === "admin" && user.active) {
      const other = await client.query(
        "SELECT 1 FROM metro_profiles WHERE role='admin' AND active AND user_id<>$1",
        [targetId],
      );
      if (!other.rowCount)
        throw new AppError(
          "last_admin",
          "The last active administrator cannot be deleted.",
          409,
        );
    }
    const operations = await client.query<{
      status: string;
      live: boolean;
      checkpoint: Record<string, unknown>;
      result: Record<string, unknown>;
    }>(
      `SELECT status,COALESCE(lease_until>now(),false) AS live,checkpoint,result FROM metro_operations
       WHERE actor_id=$1 OR payload->>'updateId' IN (SELECT id::text FROM metro_operations WHERE actor_id=$1)
       ORDER BY id FOR UPDATE`,
      [targetId],
    );
    const completed = new Set([
      "succeeded",
      "published",
      "closed_unmerged",
      "superseded",
    ]);
    if (
      operations.rows.some(
        (op) =>
          op.live ||
          (!completed.has(op.status) &&
            (["outcome_unknown", "awaiting_review", "merged"].includes(
              op.status,
            ) ||
              op.result.prNumber ||
              [
                "writeIntent",
                "prIntent",
                "mergeIntent",
                "editIntent",
                "closeIntent",
                "refreshIntent",
              ].some((key) => op.checkpoint[key]))),
      )
    )
      throw new AppError(
        "account_delete_busy",
        "Finish or reconcile this account's outstanding work before deleting it.",
        409,
      );
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `email-address:${user.email.toLowerCase()}`,
    ]);
    const sending = await client.query(
      `SELECT 1 FROM metro_email_jobs WHERE user_id=$1 AND status='sending'
       UNION ALL SELECT 1 FROM metro_subscription_mail m JOIN metro_invitations i ON i.id=m.invitation_id
       WHERE lower(i.email)=lower($2) AND m.status='sending' LIMIT 1`,
      [targetId, user.email],
    );
    if (sending.rowCount)
      throw new AppError(
        "account_delete_busy",
        "Wait for current email delivery to finish before deleting this account.",
        409,
      );

    // Snapshot trust before actor_id is detached. Do not bump completed event timestamps:
    // doing so would make historical discussions eligible for notification backfill.
    await client.query(
      `UPDATE metro_operations SET checkpoint=checkpoint || jsonb_build_object('accountDeleted',true,
       'authorRole',COALESCE(checkpoint->>'authorRole','collaborator')) WHERE actor_id=$1`,
      [targetId],
    );
    await client.query(
      `UPDATE metro_operations SET status='failed',error_code='account_deleted',
       checkpoint=checkpoint || '{"autoRetry":false}'::jsonb,updated_at=now()
       WHERE actor_id=$1 AND status NOT IN ('succeeded','published','closed_unmerged','superseded')`,
      [targetId],
    );
    await client.query(
      `UPDATE metro_outbox SET state='done',updated_at=now() WHERE operation_id IN
       (SELECT id FROM metro_operations WHERE actor_id=$1)`,
      [targetId],
    );
    await client.query(
      "UPDATE metro_edit_sessions SET expires_at=LEAST(expires_at,now()) WHERE owner_id=$1",
      [targetId],
    );
    await client.query(
      "UPDATE metro_uploads SET expires_at=LEAST(expires_at,now()) WHERE owner_id=$1",
      [targetId],
    );
    await client.query(
      `UPDATE metro_email_jobs SET status='skipped',error_code='account_deleted',updated_at=now()
       WHERE user_id=$1 AND status='pending'`,
      [targetId],
    );
    await client.query(
      `UPDATE metro_email_outbox SET state='done',updated_at=now() WHERE job_id IN
       (SELECT id FROM metro_email_jobs WHERE user_id=$1 AND error_code='account_deleted')`,
      [targetId],
    );
    await client.query(
      "UPDATE metro_invitations SET revoked_at=COALESCE(revoked_at,now()) WHERE user_id=$1 OR lower(email)=lower($2)",
      [targetId, user.email],
    );
    await client.query(
      `UPDATE metro_subscription_mail SET status='skipped',updated_at=now() WHERE status='pending' AND invitation_id IN
       (SELECT id FROM metro_invitations WHERE user_id=$1 OR lower(email)=lower($2))`,
      [targetId, user.email],
    );
    await client.query(
      'DELETE FROM "verification" WHERE identifier=$1 OR lower(identifier)=lower($2)',
      [targetId, user.email],
    );
    await audit(client, actorId, "account.delete", targetId);
    // Cascades remove credentials, sessions, profile, preferences and scoped tokens.
    // Migration 007 detaches history/jobs; address suppression is intentionally untouched.
    await client.query('DELETE FROM "user" WHERE id=$1', [targetId]);
  });
}
