import "server-only";
import type { PoolClient } from "pg";
import type { CommentPayload, GeneralRequest } from "@/lib/contracts";
import { query } from "@/server/db";
import { abuseDigest, trustedClientIp } from "@/server/security";
import { PipelineError } from "./errors";

export function guestMentionLimit(): number {
  const value = process.env.GUEST_MENTIONS_PER_DAY?.trim();
  const parsed = Number(value);
  return value &&
    /^\d+$/.test(value) &&
    Number.isSafeInteger(parsed) &&
    parsed > 0
    ? parsed
    : 3;
}

function windowStart() {
  return new Date(Math.floor(Date.now() / 86_400_000) * 86_400_000);
}

function quotaDigest(request: Request) {
  return abuseDigest(`guest-mentions-day:${trustedClientIp(request)}`);
}

export async function guestMentionRemaining(request: Request): Promise<number> {
  const limit = guestMentionLimit();
  if (
    process.env.DISABLE_RATE_LIMITS === "true" &&
    (process.env.NODE_ENV === "development" || process.env.NODE_ENV === "test")
  )
    return limit;
  const result = await query<{ count: number }>(
    "SELECT count FROM metro_rate_limits WHERE key_digest=$1 AND window_start=$2",
    [quotaDigest(request), windowStart()],
  );
  return Math.max(0, limit - (result.rows[0]?.count ?? 0));
}

export async function reserveGuestMentions(
  client: PoolClient,
  request: Request,
  count: number,
): Promise<void> {
  if (
    !count ||
    (process.env.DISABLE_RATE_LIMITS === "true" &&
      (process.env.NODE_ENV === "development" ||
        process.env.NODE_ENV === "test"))
  )
    return;
  const limit = guestMentionLimit();
  const start = windowStart();
  const result = await client.query<{ count: number }>(
    `INSERT INTO metro_rate_limits(key_digest,window_start,count,expires_at)
     VALUES($1,$2,$3,$4)
     ON CONFLICT(key_digest,window_start) DO UPDATE
     SET count=metro_rate_limits.count + EXCLUDED.count RETURNING count`,
    [
      quotaDigest(request),
      start,
      count,
      new Date(start.getTime() + 2 * 86_400_000),
    ],
  );
  if (result.rows[0].count > limit)
    throw new PipelineError("guest_mention_limit", 429);
}

export async function resolveMentions(
  payload: CommentPayload | GeneralRequest,
): Promise<string[]> {
  const selected = payload.mentions ?? [];
  if (!selected.length) return [];
  const ids = [...new Set(selected.map((item) => item.userId))];
  const result = await query<{ id: string; name: string }>(
    `SELECT u.id,u.name FROM "user" u JOIN metro_profiles p ON p.user_id=u.id
     WHERE u.id=ANY($1::text[]) AND p.active AND p.role IN ('collaborator','admin')`,
    [ids],
  );
  const names = new Map(result.rows.map((item) => [item.id, item.name]));
  if (names.size !== ids.length)
    throw new PipelineError("invalid_mention", 422);
  let previousEnd = 0;
  for (const mention of [...selected].sort((a, b) => a.start - b.start)) {
    const name = names.get(mention.userId)!;
    if (
      mention.start < previousEnd ||
      mention.end > payload.comment.length ||
      payload.comment.slice(mention.start, mention.end) !== `@${name}` ||
      (mention.start > 0 &&
        /[\p{L}\p{N}_]/u.test(payload.comment[mention.start - 1])) ||
      (mention.end < payload.comment.length &&
        /[\p{L}\p{N}_]/u.test(payload.comment[mention.end]))
    )
      throw new PipelineError("invalid_mention", 422);
    previousEnd = mention.end;
  }
  return ids;
}

export async function mentionSuggestions(queryText: string) {
  const search = queryText.trim();
  if (!search || search.length > 64) return [];
  const escaped = search.replace(/[\\%_]/g, "\\$&");
  const result = await query<{ id: string; name: string; role: string }>(
    `SELECT u.id,u.name,p.role FROM "user" u JOIN metro_profiles p ON p.user_id=u.id
     WHERE p.active AND p.role IN ('collaborator','admin') AND u.name ILIKE $1 ESCAPE '\\'
     ORDER BY lower(u.name),u.id LIMIT 10`,
    [`${escaped}%`],
  );
  return result.rows;
}
