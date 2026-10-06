import "server-only";
import { query } from "@/server/db";
import { AppError } from "@/server/http";
import { getAuth } from "./config";

export type ActiveUser = {
  id: string;
  email: string;
  name: string;
  role: "collaborator" | "admin";
};

/** Also used by workers immediately before performing a collaborator's external write. */
export async function getActiveUser(id: string): Promise<ActiveUser> {
  const result = await query<ActiveUser & { active: boolean }>(
    'SELECT u.id, u.email, u.name, p.role, p.active FROM "user" u JOIN metro_profiles p ON p.user_id = u.id WHERE u.id = $1',
    [id],
  );
  const user = result.rows[0];
  if (!user?.active)
    throw new AppError(
      "unauthorized",
      "Please sign in with an active collaborator account.",
      401,
    );
  return { id: user.id, email: user.email, name: user.name, role: user.role };
}

async function authenticated(request: Request) {
  const session = await getAuth().api.getSession({
    headers: request.headers,
    query: { disableCookieCache: true },
  });
  if (!session)
    throw new AppError("unauthorized", "Please sign in to continue.", 401);
  const current = await query(
    `SELECT s.id FROM "session" s JOIN metro_profiles p ON p.user_id = s."userId"
     WHERE s.id = $1 AND s."expiresAt" > now() AND p.active AND s."authVersion" = p.auth_version`,
    [session.session.id],
  );
  if (!current.rowCount)
    throw new AppError(
      "unauthorized",
      "Your session has expired. Please sign in again.",
      401,
    );
  // Always check database authorization. Role and enabled status are never taken from a browser claim.
  const user = await getActiveUser(session.user.id);
  return { user, session: session.session };
}

export async function requireUser(request: Request): Promise<ActiveUser> {
  return (await authenticated(request)).user;
}

export async function requireAdmin(
  request: Request,
  options: { fresh?: boolean } = {},
): Promise<ActiveUser> {
  const { user, session } = await authenticated(request);
  if (user.role !== "admin")
    throw new AppError("forbidden", "Administrator access is required.", 403);
  if (
    options.fresh !== false &&
    Date.now() - new Date(session.createdAt).getTime() > 15 * 60_000
  ) {
    throw new AppError(
      "fresh_auth_required",
      "Sign out and sign in again before managing accounts or settings.",
      401,
    );
  }
  return user;
}
