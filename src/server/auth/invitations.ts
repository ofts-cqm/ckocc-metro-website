import "server-only";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { PoolClient, QueryResultRow } from "pg";
import { z } from "zod";
import { query, transaction } from "@/server/db";
import { AppError } from "@/server/http";
import { siteOrigin } from "./config";
import {
  createCredentialAccount,
  lockIdentityStore,
  revokeUserSessions,
} from "./credentials";
import {
  hashPassword,
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
} from "./password";

export const invitationSchema = z
  .object({
    email: z
      .string()
      .trim()
      .email()
      .max(254)
      .transform((value) => value.toLowerCase()),
    displayName: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .refine((value) => !/[\u0000-\u001f\u007f]/u.test(value)),
    role: z.enum(["collaborator", "admin"]),
    locale: z.enum(["en-US", "zh-CN", "zh-HK"]).default("en-US"),
  })
  .strict();
export const resetSchema = z
  .object({ locale: z.enum(["en-US", "zh-CN", "zh-HK"]).default("en-US") })
  .strict();
export const redeemSchema = z
  .object({
    token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    password: z.string().min(MIN_PASSWORD_LENGTH).max(MAX_PASSWORD_LENGTH),
  })
  .strict();
type Invitation = QueryResultRow & {
  id: string;
  email: string;
  display_name: string;
  role: "collaborator" | "admin";
  kind: "invite" | "reset";
  user_id: string | null;
  expires_at: Date;
  consumed_at: Date | null;
  revoked_at: Date | null;
};
/** Hashes an invitation secret for database lookup.
 * Issuance and redemption use it so plaintext tokens are not stored.
 */
const tokenDigest = (token: string) =>
  createHash("sha256").update(token).digest("hex");
/** Builds the common invalid or expired link error.
 * Invitation inspection and redemption use it for rejected links.
 */
const invalidInvitation = () =>
  new AppError(
    "invalid_invitation",
    "This invitation or reset link is invalid, expired, or already used.",
    422,
  );

/** Records a durable identity action in the audit table.
 * Invite, reset, and redemption workflows call it in their transaction.
 */
export async function audit(
  client: PoolClient,
  actor: string | null,
  action: string,
  target: string,
  outcome = "success",
): Promise<void> {
  await client.query(
    "INSERT INTO metro_audit (actor_id, action, target_id, outcome) VALUES ($1, $2, $3, $4)",
    [actor, action, target, outcome],
  );
}

/** Checks that a new invited address has no account.
 * The admin invitation API calls it before issuing a link.
 */
export async function createInvitation(
  actor: string,
  input: z.infer<typeof invitationSchema>,
) {
  return transaction(async (client) => {
    await lockIdentityStore(client);
    const existing = await client.query(
      'SELECT id FROM "user" WHERE lower(email) = $1',
      [input.email],
    );
    if (existing.rowCount)
      throw new AppError(
        "account_exists",
        "This account already exists. Issue a reset link instead.",
        409,
      );
    return issueLink(client, actor, { ...input, kind: "invite", userId: null });
  });
}

/** Revokes older links and creates one expiring invite or reset URL.
 * Admin invitation and reset workflows call it under the identity lock.
 */
async function issueLink(
  client: PoolClient,
  actor: string,
  input: z.infer<typeof invitationSchema> & {
    kind: "invite" | "reset";
    userId: string | null;
  },
) {
  const token = randomBytes(32).toString("base64url");
  const id = randomUUID();
  const expiresAt = new Date(
    Date.now() + (input.kind === "reset" ? 60 * 60_000 : 24 * 60 * 60_000),
  );
  await client.query(
    "UPDATE metro_invitations SET revoked_at = now() WHERE email = $1 AND kind = $2 AND consumed_at IS NULL AND revoked_at IS NULL",
    [input.email, input.kind],
  );
  await client.query(
    "INSERT INTO metro_invitations (id, token_digest, kind, email, display_name, role, user_id, created_by, expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
    [
      id,
      tokenDigest(token),
      input.kind,
      input.email,
      input.displayName,
      input.role,
      input.userId,
      actor,
      expiresAt,
    ],
  );
  await audit(client, actor, `${input.kind}.create`, id);
  const url = new URL(`/${input.locale.toLowerCase()}/invite`, siteOrigin());
  url.searchParams.set("token", token);
  return {
    id,
    email: input.email,
    role: input.role,
    expiresAt: expiresAt.toISOString(),
    url: url.href,
  };
}

/** Checks an active account and issues a password reset link.
 * An administrator invokes it from account management.
 */
export async function createPasswordReset(
  actor: string,
  userId: string,
  locale: z.infer<typeof resetSchema>["locale"],
) {
  return transaction(async (client) => {
    await lockIdentityStore(client);
    const result = await client.query<{
      email: string;
      name: string;
      role: "collaborator" | "admin";
      active: boolean;
    }>(
      'SELECT u.email, u.name, p.role, p.active FROM "user" u JOIN metro_profiles p ON p.user_id = u.id WHERE u.id = $1 FOR UPDATE OF p',
      [userId],
    );
    const account = result.rows[0];
    if (!account) throw new AppError("not_found", "Account not found.", 404);
    if (!account.active)
      throw new AppError(
        "account_disabled",
        "Enable this account before issuing a reset link.",
        409,
      );
    return issueLink(client, actor, {
      email: account.email,
      displayName: account.name,
      role: account.role,
      locale,
      kind: "reset",
      userId,
    });
  });
}

/** Looks up a live invite or reset token for display.
 * The invitation page and redemption precheck call it.
 */
export async function inspectInvitation(token: string) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw invalidInvitation();
  const result = await query<Invitation>(
    "SELECT * FROM metro_invitations WHERE token_digest = $1 AND expires_at > now() AND consumed_at IS NULL AND revoked_at IS NULL",
    [tokenDigest(token)],
  );
  const invitation = result.rows[0];
  if (!invitation) throw invalidInvitation();
  return {
    email: invitation.email,
    displayName: invitation.display_name,
    kind: invitation.kind,
    expiresAt: invitation.expires_at.toISOString(),
  };
}

/** Consumes a link to create an account or reset credentials.
 * The invitation acceptance API calls it after password validation.
 */
export async function redeemInvitation(
  input: z.infer<typeof redeemSchema>,
): Promise<void> {
  // Cheap validation precedes the expensive hash. The transaction rechecks after hashing.
  await inspectInvitation(input.token);
  const passwordHash = await hashPassword(input.password);
  await transaction(async (client) => {
    await lockIdentityStore(client);
    const result = await client.query<Invitation>(
      "SELECT * FROM metro_invitations WHERE token_digest = $1 FOR UPDATE",
      [tokenDigest(input.token)],
    );
    const invitation = result.rows[0];
    if (
      !invitation ||
      invitation.consumed_at ||
      invitation.revoked_at ||
      invitation.expires_at.getTime() <= Date.now()
    )
      throw invalidInvitation();
    let userId: string;
    if (invitation.kind === "invite") {
      const existing = await client.query(
        'SELECT id FROM "user" WHERE lower(email) = $1',
        [invitation.email],
      );
      if (existing.rowCount) throw invalidInvitation();
      userId = await createCredentialAccount(client, {
        email: invitation.email,
        name: invitation.display_name,
        role: invitation.role,
        passwordHash,
      });
    } else {
      if (!invitation.user_id) throw invalidInvitation();
      userId = invitation.user_id;
      const profile = await client.query<{ active: boolean }>(
        "SELECT active FROM metro_profiles WHERE user_id = $1 FOR UPDATE",
        [userId],
      );
      if (!profile.rows[0]?.active) throw invalidInvitation();
      const changed = await client.query(
        'UPDATE "account" SET password = $1, "updatedAt" = now() WHERE "userId" = $2 AND "providerId" = \'credential\'',
        [passwordHash, userId],
      );
      if (!changed.rowCount) throw invalidInvitation();
      await revokeUserSessions(client, userId);
    }
    await client.query(
      "UPDATE metro_invitations SET consumed_at = now() WHERE id = $1",
      [invitation.id],
    );
    await audit(client, userId, `${invitation.kind}.redeem`, invitation.id);
  });
}
