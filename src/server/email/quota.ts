import "server-only";
import type { PoolClient } from "pg";

export function notificationDailyLimit(): number {
  const value = process.env.EMAIL_NOTIFICATIONS_PER_DAY?.trim();
  if (!value || !/^[1-9]\d*$/.test(value)) return 5;
  const limit = Number(value);
  return Number.isSafeInteger(limit) ? limit : 5;
}

/** Reserve once per notification/day. The caller commits before contacting SES.
 * Retries reuse their slot; failures/uncertain sends keep it conservatively.
 * Quota belongs to the account and survives address changes and opt-in toggles.
 */
export async function reserveNotificationSlot(
  client: PoolClient,
  job: { id: string; user_id: string },
  now = new Date(),
): Promise<{ allowed: boolean; last: boolean }> {
  const day = now.toISOString().slice(0, 10);
  const limit = notificationDailyLimit();
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
    `email-daily:${job.user_id}`,
  ]);
  const prior = await client.query<{ position: number }>(
    "SELECT position FROM metro_email_daily_slots WHERE job_id=$1 AND quota_day=$2::date",
    [job.id, day],
  );
  if (prior.rows[0]) {
    const position = prior.rows[0].position;
    return { allowed: position <= limit, last: position === limit };
  }
  const count = await client.query<{ used: number }>(
    "SELECT count(*)::integer AS used FROM metro_email_daily_slots WHERE user_id=$1 AND quota_day=$2::date",
    [job.user_id, day],
  );
  const used = count.rows[0].used;
  if (used >= limit) return { allowed: false, last: false };
  await client.query(
    `INSERT INTO metro_email_daily_slots(job_id,user_id,quota_day,position)
     VALUES($1,$2,$3::date,$4)`,
    [job.id, job.user_id, day, used + 1],
  );
  return { allowed: true, last: used + 1 === limit };
}
