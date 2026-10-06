import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";

/** Account mutations are rare; one transaction lock gives all invite/reset/admin paths a safe order. */
export async function lockIdentityStore(client: PoolClient): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(2147031999)");
}

/** Server/CLI adapter for the documented Better Auth credential schema.
 * The caller owns the transaction so account creation and invitation consumption are atomic.
 * Better Auth remains responsible for hashing configuration, sign-in, cookies, and sessions.
 */
export async function createCredentialAccount(
  client: PoolClient,
  input: {
    email: string;
    name: string;
    role: "collaborator" | "admin";
    passwordHash: string;
  },
): Promise<string> {
  const id = randomUUID();
  await client.query(
    'INSERT INTO "user" (id, name, email, "emailVerified") VALUES ($1, $2, $3, false)',
    [id, input.name, input.email],
  );
  await client.query(
    'INSERT INTO "account" (id, "accountId", "providerId", "userId", password) VALUES ($1, $2, \'credential\', $2, $3)',
    [randomUUID(), id, input.passwordHash],
  );
  await client.query(
    "INSERT INTO metro_profiles (user_id, role) VALUES ($1, $2)",
    [id, input.role],
  );
  return id;
}

export async function revokeUserSessions(
  client: PoolClient,
  userId: string,
): Promise<void> {
  await client.query(
    "UPDATE metro_profiles SET auth_version = auth_version + 1, updated_at = now() WHERE user_id = $1",
    [userId],
  );
  await client.query('DELETE FROM "session" WHERE "userId" = $1', [userId]);
}
