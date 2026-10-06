import "server-only";
import { createHmac } from "node:crypto";
import { isIP } from "node:net";
import { query, transaction } from "@/server/db";
import { AppError } from "@/server/http";
import { siteOrigin } from "@/server/auth/config";

export function enforceSameOrigin(request: Request): void {
  if (request.headers.get("origin") !== siteOrigin())
    throw new AppError(
      "forbidden_origin",
      "This request must originate from this website.",
      403,
    );
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none")
    throw new AppError(
      "forbidden_origin",
      "This request must originate from this website.",
      403,
    );
}

export function trustedClientIp(request: Request): string {
  // Only Vercel's platform-overwritten header is trusted in the supported production deployment.
  if (process.env.VERCEL === "1" && process.env.TRUST_PROXY === "vercel") {
    const ip = request.headers.get("x-vercel-forwarded-for")?.trim();
    if (ip && isIP(ip)) return ip;
    throw new AppError(
      "security_unavailable",
      "Client verification is temporarily unavailable.",
      503,
    );
  }
  // Local development has one deliberately shared bucket; arbitrary forwarded headers are ignored.
  if (process.env.NODE_ENV !== "production") return "local-development";
  throw new AppError(
    "security_unavailable",
    "Trusted proxy configuration is required before accepting writes.",
    503,
  );
}

export function abuseDigest(value: string): string {
  const secret = process.env.ABUSE_HASH_SECRET;
  if (!secret || secret.length < 32)
    throw new AppError(
      "security_unavailable",
      "Submission protection is not configured.",
      503,
    );
  return createHmac("sha256", secret).update(value).digest("hex");
}

type Limit = { key: string; max: number; seconds: number };

/** Fixed windows are incremented in one transaction and survive serverless instance changes. */
export async function enforceRateLimits(limits: Limit[]): Promise<void> {
  const now = Date.now();
  const normalized = limits
    .map((limit) => ({
      ...limit,
      digest: abuseDigest(limit.key),
      start: Math.floor(now / (limit.seconds * 1000)) * limit.seconds * 1000,
    }))
    .sort((a, b) => a.digest.localeCompare(b.digest));
  const blocked = await transaction(async (client) => {
    let retryAfter = 0;
    for (const limit of normalized) {
      const end = limit.start + limit.seconds * 1000;
      const result = await client.query<{ count: number }>(
        `INSERT INTO metro_rate_limits (key_digest, window_start, count, expires_at) VALUES ($1, $2, 1, $3)
         ON CONFLICT (key_digest, window_start) DO UPDATE SET count = metro_rate_limits.count + 1 RETURNING count`,
        [limit.digest, new Date(limit.start), new Date(end + 24 * 60 * 60_000)],
      );
      if (result.rows[0].count > limit.max)
        retryAfter = Math.max(retryAfter, Math.ceil((end - now) / 1000));
    }
    return retryAfter;
  });
  if (blocked) {
    const error = new AppError(
      "rate_limited",
      "Too many attempts. Please wait before trying again.",
      429,
    ) as AppError & { retryAfter: number };
    error.retryAfter = blocked;
    throw error;
  }
}

export async function requireLoginAttempt(
  request: Request,
  email: string,
): Promise<void> {
  const ip = trustedClientIp(request);
  await enforceRateLimits([
    {
      key: `login-pair:${ip}:${email.trim().toLowerCase()}`,
      max: 5,
      seconds: 900,
    },
    { key: `login-ip:${ip}`, max: 30, seconds: 900 },
  ]);
}

export async function clearSuccessfulLogin(
  request: Request,
  email: string,
): Promise<void> {
  await query("DELETE FROM metro_rate_limits WHERE key_digest = $1", [
    abuseDigest(
      `login-pair:${trustedClientIp(request)}:${email.trim().toLowerCase()}`,
    ),
  ]);
}

export async function requireAnonymousWrite(
  request: Request,
  action: "request" | "comment",
  challenge: string,
  idempotencyKey: string,
): Promise<void> {
  enforceSameOrigin(request);
  const settings = await query<{ public_writes_paused: boolean }>(
    "SELECT public_writes_paused FROM metro_settings WHERE singleton = true",
  );
  if (!settings.rows[0] || settings.rows[0].public_writes_paused)
    throw new AppError(
      "anonymous_writes_paused",
      "Public submissions are temporarily paused.",
      503,
    );
  const ip = trustedClientIp(request);
  await enforceRateLimits([
    {
      key: `${action}-hour:${ip}`,
      max: action === "request" ? 3 : 10,
      seconds: 3600,
    },
    {
      key: `${action}-day:${ip}`,
      max: action === "request" ? 10 : 30,
      seconds: 86_400,
    },
  ]);
  if (typeof challenge !== "string" || !challenge || challenge.length > 2048)
    throw new AppError(
      "challenge_failed",
      "Please complete the verification challenge again.",
      422,
    );
  const secret = process.env.TURNSTILE_SECRET_KEY;
  const hostname =
    process.env.TURNSTILE_HOSTNAME || new URL(siteOrigin()).hostname;
  if (!secret)
    throw new AppError(
      "security_unavailable",
      "Submission verification is not configured.",
      503,
    );
  const form = new URLSearchParams({ secret, response: challenge });
  if (isIP(ip)) form.set("remoteip", ip);
  // Cloudflare's idempotency key accepts UUIDs. Other app keys remain valid without forwarding them.
  if (
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      idempotencyKey,
    )
  )
    form.set("idempotency_key", idempotencyKey);
  let data: { success?: boolean; action?: string; hostname?: string };
  try {
    const result = await fetch(
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
      {
        method: "POST",
        body: form,
        signal: AbortSignal.timeout(10_000),
        cache: "no-store",
      },
    );
    if (!result.ok) throw new Error("Verification unavailable");
    data = await result.json();
  } catch {
    throw new AppError(
      "security_unavailable",
      "Verification is temporarily unavailable. Keep your draft and retry.",
      503,
    );
  }
  if (!data.success || data.action !== action || data.hostname !== hostname)
    throw new AppError(
      "challenge_failed",
      "Please complete the verification challenge again.",
      422,
    );
  // Failed bot challenges must not consume the entire site's shared publication allowance.
  await enforceRateLimits([{ key: "public-global", max: 60, seconds: 3600 }]);
}

/** Invites remain secret credentials; rate limiting prevents token probes and expensive hashing floods. */
export async function requireInvitationAttempt(
  request: Request,
): Promise<void> {
  await enforceRateLimits([
    { key: `invitation:${trustedClientIp(request)}`, max: 20, seconds: 900 },
  ]);
}

/** Call from the authenticated daily repair job; retention never relies on instance memory. */
export async function pruneSecurityRecords(): Promise<void> {
  await transaction(async (client) => {
    await client.query(
      "DELETE FROM metro_rate_limits WHERE expires_at < now()",
    );
    await client.query('DELETE FROM "session" WHERE "expiresAt" < now()');
    await client.query('DELETE FROM "verification" WHERE "expiresAt" < now()');
    await client.query(
      "DELETE FROM metro_invitations WHERE expires_at < now() - interval '30 days'",
    );
    await client.query(
      "DELETE FROM metro_audit WHERE created_at < now() - interval '180 days'",
    );
  });
}
