import "server-only";
import { createHash, createHmac, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { AppError } from "@/server/http";

export const EMAIL_TOKEN_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[A-Za-z0-9_-]{43}$/;

/** Reconstructable only with the server secret; the database stores a digest.
 * Verification sending and link validation use it.
 */
export function tokenValue(id: string): string {
  const secret =
    process.env.EMAIL_TOKEN_SECRET || process.env.BETTER_AUTH_SECRET;
  if (!secret || secret.length < 32)
    throw new AppError(
      "email_not_configured",
      "Email links are not configured.",
      503,
    );
  return `${id}.${createHmac("sha256", secret).update(`metro-email-token:v1:${id}`).digest("base64url")}`;
}
/** Hashes a token for persistent lookup without storing it.
 * Email token creation and consumption use it.
 */
export const tokenDigest = (token: string) =>
  createHash("sha256").update(token).digest("hex");

/** Stores a one-use unsubscribe token for an address.
 * The email sender creates it for notification messages.
 */
export async function createUnsubscribeToken(
  client: PoolClient,
  userId: string,
  address: string,
): Promise<string> {
  const id = randomUUID();
  const token = tokenValue(id);
  await client.query(
    `INSERT INTO metro_email_tokens (id,user_id,purpose,address,token_digest,expires_at)
     VALUES ($1,$2,'unsubscribe',$3,$4,now() + interval '1 year')`,
    [id, userId, address.trim().toLowerCase(), tokenDigest(token)],
  );
  return token;
}
