import "server-only";
import { query } from "@/server/db";
import type { NotificationItem } from "@/lib/contracts";
import { PipelineError } from "./errors";

export function notificationRecipientWhere(user = "$1") {
  return `o.status='succeeded' AND EXISTS (SELECT 1 FROM metro_profiles recipient_profile WHERE recipient_profile.user_id=${user} AND recipient_profile.active AND recipient_profile.role IN ('collaborator','admin')) AND (
  ((o.kind='comment' OR (o.kind='request' AND o.payload->>'kind'='general')) AND
   o.payload->'mentions' @> jsonb_build_array(jsonb_build_object('userId',${user}::text)))
  OR (o.kind='comment' AND EXISTS (SELECT 1 FROM metro_operations parent
           WHERE parent.kind='comment' AND parent.status='succeeded'
             AND parent.actor_id=${user}
             AND parent.result->>'commentId'=o.payload->>'replyToCommentId'
             AND parent.payload->>'issueNumber'=o.payload->>'issueNumber'
             AND parent.checkpoint->>'repository'=o.checkpoint->>'repository'))
  OR (o.kind='request' AND o.payload->>'kind'='line-update'
      AND o.payload->>'notifyAdmins'='true'
      AND EXISTS (SELECT 1 FROM metro_profiles profile
                  WHERE profile.user_id=${user} AND profile.role='admin' AND profile.active))
  ) AND
  (o.actor_id IS NULL OR o.actor_id<>${user})`;
}

export function notificationKindSql(user = "$1") {
  return `CASE WHEN o.kind='request' AND o.payload->>'kind'='line-update'
                   AND o.payload->>'operation'='add' THEN 'line-add'
         WHEN o.kind='request' AND o.payload->>'kind'='line-update' THEN 'line-update'
         WHEN EXISTS (SELECT 1 FROM metro_operations parent
         WHERE parent.kind='comment' AND parent.status='succeeded'
           AND parent.actor_id=${user} AND parent.result->>'commentId'=o.payload->>'replyToCommentId'
           AND parent.payload->>'issueNumber'=o.payload->>'issueNumber'
           AND parent.checkpoint->>'repository'=o.checkpoint->>'repository')
         THEN 'reply' ELSE 'mention' END`;
}

// Successful operations are durable inbox events, without a second delivery table.
export async function listNotifications(userId: string) {
  const marker = await query<{ through: Date | null }>(
    `SELECT max(o.updated_at) AS through FROM metro_audit a
     JOIN metro_operations o ON o.id::text=a.target_id
     WHERE a.actor_id=$1 AND a.action='notifications.viewed'`,
    [userId],
  );
  const through = marker.rows[0]?.through ?? null;
  const values = [userId, through];
  const items = await query<NotificationItem>(
    `SELECT o.id::text AS id,
       ${notificationKindSql()} AS kind,
       o.payload->>'gameName' AS sender,
       CASE WHEN o.kind='request' THEN (o.result->>'number')::integer
         ELSE (o.payload->>'issueNumber')::integer END AS "issueNumber",
       o.updated_at AS "createdAt", (o.updated_at <= $2::timestamptz) AS read
     FROM metro_operations o
     WHERE ${notificationRecipientWhere()}
     ORDER BY o.updated_at DESC,o.id DESC LIMIT 50`,
    values,
  );
  const count = await query<{ unread: string }>(
    `SELECT count(*)::text AS unread FROM metro_operations o
     WHERE ${notificationRecipientWhere()} AND ($2::timestamptz IS NULL OR o.updated_at>$2::timestamptz)`,
    values,
  );
  return {
    notifications: items.rows.map((item) => ({
      ...item,
      createdAt: new Date(item.createdAt).toISOString(),
      read: !!item.read,
    })),
    unreadCount: Number(count.rows[0]?.unread ?? 0),
  };
}

export async function markNotificationsRead(userId: string, throughId: string) {
  const visible = await listNotifications(userId);
  if (!visible.notifications.some((item) => item.id === throughId))
    throw new PipelineError("notification_not_found", 404);
  await query(
    `INSERT INTO metro_audit(actor_id,action,target_id,outcome)
     VALUES($1,'notifications.viewed',$2,'success')`,
    [userId, throughId],
  );
}
