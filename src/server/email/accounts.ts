import "server-only";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { query, transaction } from "@/server/db";
import { AppError } from "@/server/http";
import {
  lockIdentityStore,
  revokeUserSessions,
} from "@/server/auth/credentials";
import { verifyPassword, MAX_PASSWORD_LENGTH } from "@/server/auth/password";
import { enforceRateLimits, trustedClientIp } from "@/server/security";
import { enqueueVerification } from "./jobs";
import { EMAIL_TOKEN_PATTERN, tokenDigest, tokenValue } from "./tokens";

const localeSchema = z.enum(["en-us", "zh-cn", "zh-hk"]);
export const preferencesSchema = z
  .object({ enabled: z.boolean(), locale: localeSchema })
  .strict();
export const verificationSchema = z
  .object({
    locale: localeSchema,
    address: z
      .string()
      .trim()
      .email()
      .max(254)
      .transform((value) => value.toLowerCase())
      .optional(),
    password: z.string().max(MAX_PASSWORD_LENGTH).optional(),
  })
  .strict();
export const emailTokenSchema = z
  .object({ token: z.string().regex(EMAIL_TOKEN_PATTERN) })
  .strict();
/** Builds a shared error for invalid email action links.
 * Verification and unsubscribe handling use it.
 */
const invalidLink = () =>
  new AppError(
    "invalid_link",
    "This email link is invalid, expired, or already used.",
    422,
  );

/** Reads verification, preference, pending-address, and suppression state.
 * The account settings API and verification request use it.
 */
export async function emailSettings(userId: string) {
  const result = await query<{
    email: string;
    verified: boolean;
    enabled: boolean;
    locale: string;
    pendingAddress: string | null;
    suppressed: boolean;
  }>(
    `SELECT u.email, u."emailVerified" AS verified, COALESCE(e.enabled,false) AS enabled,
      COALESCE(e.locale,'en-us') AS locale,
      (SELECT t.address FROM metro_email_tokens t WHERE t.user_id=u.id AND t.purpose='change'
       AND t.consumed_at IS NULL AND t.expires_at>now() AND t.auth_version=p.auth_version
       AND t.source_email=lower(u.email) ORDER BY t.created_at DESC LIMIT 1) AS "pendingAddress",
      EXISTS(SELECT 1 FROM metro_email_suppressions s WHERE s.address=lower(u.email)) AS suppressed
      FROM "user" u JOIN metro_profiles p ON p.user_id=u.id
      LEFT JOIN metro_email_preferences e ON e.user_id=u.id WHERE u.id=$1 AND p.active`,
    [userId],
  );
  if (!result.rows[0])
    throw new AppError("unauthorized", "Please sign in again.", 401);
  return result.rows[0];
}

/** Stores opt-in and locale changes with a consent version.
 * The settings API calls it when a member changes email preferences.
 */
export async function setEmailPreferences(
  userId: string,
  input: z.infer<typeof preferencesSchema>,
) {
  await transaction(async (client) => {
    await lockIdentityStore(client);
    const active = await client.query(
      "SELECT user_id FROM metro_profiles WHERE user_id=$1 AND active FOR UPDATE",
      [userId],
    );
    if (!active.rowCount)
      throw new AppError("unauthorized", "Please sign in again.", 401);
    await client.query(
      `INSERT INTO metro_email_preferences (user_id,enabled,locale,consent_version,consent_at)
      VALUES ($1,$2,$3,1,CASE WHEN $2 THEN now() ELSE NULL END)
      ON CONFLICT(user_id) DO UPDATE SET enabled=EXCLUDED.enabled, locale=EXCLUDED.locale,
      consent_version=metro_email_preferences.consent_version + CASE WHEN metro_email_preferences.enabled<>EXCLUDED.enabled THEN 1 ELSE 0 END,
      consent_at=CASE WHEN EXCLUDED.enabled AND NOT metro_email_preferences.enabled THEN now() ELSE metro_email_preferences.consent_at END,
      updated_at=now()`,
      [userId, input.enabled, input.locale],
    );
  });
}

/** Checks address ownership and enqueues a scoped confirmation link.
 * The settings workflow calls it for verification or address changes.
 */
export async function requestEmailVerification(
  request: Request,
  userId: string,
  input: z.infer<typeof verificationSchema>,
) {
  // Check the current address and apply request-level abuse limits.
  const current = await emailSettings(userId);
  const address = input.address ?? current.email.toLowerCase();
  await enforceRateLimits([
    { key: `email-verification-user:${userId}`, max: 5, seconds: 3600 },
    { key: `email-verification-address:${address}`, max: 5, seconds: 3600 },
    {
      key: `email-verification-ip:${trustedClientIp(request)}`,
      max: 20,
      seconds: 3600,
    },
  ]);
  return transaction(async (client) => {
    // Lock identity and verify ownership before replacing any active link.
    await lockIdentityStore(client);
    const result = await client.query<{
      email: string;
      emailVerified: boolean;
      auth_version: number;
      password: string;
    }>(
      `SELECT u.email,u."emailVerified",p.auth_version,a.password FROM "user" u
       JOIN metro_profiles p ON p.user_id=u.id JOIN "account" a ON a."userId"=u.id AND a."providerId"='credential'
       WHERE u.id=$1 AND p.active FOR UPDATE OF u,p,a`,
      [userId],
    );
    const user = result.rows[0];
    if (!user) throw new AppError("unauthorized", "Please sign in again.", 401);
    const changing = address !== user.email.toLowerCase();
    if (
      changing &&
      (!input.password ||
        !(await verifyPassword({
          hash: user.password,
          password: input.password,
        })))
    )
      throw new AppError(
        "password_invalid",
        "Your current password is required.",
        403,
      );
    if (!changing && user.emailVerified) return { queued: false };
    const duplicate = await client.query(
      'SELECT id FROM "user" WHERE lower(email)=$1 AND id<>$2',
      [address, userId],
    );
    if (duplicate.rowCount)
      throw new AppError(
        "account_exists",
        "This address is already in use.",
        409,
      );
    const suppression = await client.query(
      "SELECT address FROM metro_email_suppressions WHERE address=$1",
      [address],
    );
    if (suppression.rowCount)
      throw new AppError(
        "email_suppressed",
        "Email delivery to this address is suppressed. Contact an administrator.",
        409,
      );
    // A new request supersedes all previous confirmation links for this account.
    await client.query(
      "UPDATE metro_email_tokens SET consumed_at=now() WHERE user_id=$1 AND purpose IN ('verification','change') AND consumed_at IS NULL",
      [userId],
    );
    const id = randomUUID();
    await client.query(
      `INSERT INTO metro_email_tokens (id,user_id,purpose,address,token_digest,expires_at,source_email,auth_version)
      VALUES ($1,$2,$3,$4,$5,now() + interval '1 hour',$6,$7)`,
      [
        id,
        userId,
        changing ? "change" : "verification",
        address,
        tokenDigest(tokenValue(id)),
        user.email.toLowerCase(),
        user.auth_version,
      ],
    );
    await enqueueVerification(client, {
      userId,
      address,
      tokenId: id,
      locale: input.locale,
    });
    return { queued: true };
  });
}

/** Consumes a verification, change, or unsubscribe link once.
 * Email link APIs call it to update account state safely.
 */
export async function consumeEmailToken(
  token: string,
  purpose: "verify" | "unsubscribe",
) {
  if (!EMAIL_TOKEN_PATTERN.test(token)) throw invalidLink();
  return transaction(async (client) => {
    // Lock the account and one-use token before applying either link action.
    await lockIdentityStore(client);
    const candidate = await client.query<{ user_id: string }>(
      "SELECT user_id FROM metro_email_tokens WHERE token_digest=$1",
      [tokenDigest(token)],
    );
    if (!candidate.rows[0]) throw invalidLink();
    await client.query(
      'SELECT u.id FROM "user" u JOIN metro_profiles p ON p.user_id=u.id WHERE u.id=$1 FOR UPDATE OF u,p',
      [candidate.rows[0].user_id],
    );
    const result = await client.query<{
      id: string;
      user_id: string;
      purpose: string;
      address: string;
      source_email: string | null;
      auth_version: number | null;
      email: string;
      current_version: number;
      active: boolean;
    }>(
      `SELECT t.id,t.user_id,t.purpose,t.address,t.source_email,t.auth_version,u.email,p.auth_version AS current_version,p.active
      FROM metro_email_tokens t JOIN "user" u ON u.id=t.user_id JOIN metro_profiles p ON p.user_id=t.user_id
      WHERE t.token_digest=$1 AND t.consumed_at IS NULL AND t.expires_at>now() FOR UPDATE OF t`,
      [tokenDigest(token)],
    );
    const row = result.rows[0];
    if (
      !row ||
      (purpose === "unsubscribe"
        ? row.purpose !== "unsubscribe"
        : !["verification", "change"].includes(row.purpose))
    )
      throw invalidLink();
    if (purpose === "unsubscribe") {
      // An old mailbox's link cannot alter preferences for a replacement mailbox.
      if (row.address !== row.email.toLowerCase()) throw invalidLink();
      await client.query(
        `UPDATE metro_email_preferences SET enabled=false,consent_version=consent_version+1,updated_at=now() WHERE user_id=$1`,
        [row.user_id],
      );
    } else {
      // Verification and address changes require the original account state.
      if (
        !row.active ||
        row.source_email !== row.email.toLowerCase() ||
        row.auth_version !== row.current_version
      )
        throw invalidLink();
      const duplicate = await client.query(
        'SELECT id FROM "user" WHERE lower(email)=$1 AND id<>$2',
        [row.address, row.user_id],
      );
      if (duplicate.rowCount)
        throw new AppError(
          "account_exists",
          "This address is already in use.",
          409,
        );
      await client.query(
        'UPDATE "user" SET email=$1,"emailVerified"=true,"updatedAt"=now() WHERE id=$2',
        [row.address, row.user_id],
      );
      if (row.purpose === "change") {
        await revokeUserSessions(client, row.user_id);
        await client.query(
          "UPDATE metro_email_preferences SET consent_version=consent_version+1,consent_at=CASE WHEN enabled THEN now() ELSE consent_at END,updated_at=now() WHERE user_id=$1",
          [row.user_id],
        );
      }
      await client.query(
        "UPDATE metro_email_tokens SET consumed_at=now() WHERE user_id=$1 AND purpose IN ('verification','change') AND consumed_at IS NULL",
        [row.user_id],
      );
    }
    await client.query(
      "UPDATE metro_email_tokens SET consumed_at=now() WHERE id=$1",
      [row.id],
    );
    return { changed: row.purpose === "change" };
  });
}
