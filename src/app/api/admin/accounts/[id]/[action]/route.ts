import { requireAdmin } from "@/server/auth/authorize";
import {
  lockIdentityStore,
  revokeUserSessions,
} from "@/server/auth/credentials";
import {
  audit,
  createPasswordReset,
  resetSchema,
} from "@/server/auth/invitations";
import { transaction } from "@/server/db";
import { AppError, errorResponse, json, readJson } from "@/server/http";
import { enforceSameOrigin } from "@/server/security";

export const runtime = "nodejs";
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string; action: string }> },
): Promise<Response> {
  try {
    enforceSameOrigin(request);
    const actor = await requireAdmin(request);
    const { id, action } = await context.params;
    if (action === "reset") {
      const { locale } = resetSchema.parse(await readJson(request, 1024));
      return json(
        { invitation: await createPasswordReset(actor.id, id, locale) },
        201,
      );
    }
    if (action !== "disable" && action !== "enable")
      throw new AppError("not_found", "Not found.", 404);
    if (id === actor.id && action === "disable")
      throw new AppError(
        "cannot_disable_self",
        "Ask another administrator to disable your account.",
        409,
      );
    await transaction(async (client) => {
      await lockIdentityStore(client);
      const target = await client.query<{ role: string; active: boolean }>(
        "SELECT role, active FROM metro_profiles WHERE user_id = $1 FOR UPDATE",
        [id],
      );
      if (!target.rowCount)
        throw new AppError("not_found", "Account not found.", 404);
      if (
        action === "disable" &&
        target.rows[0].role === "admin" &&
        target.rows[0].active
      ) {
        const remaining = await client.query(
          "SELECT user_id FROM metro_profiles WHERE role = 'admin' AND active AND user_id <> $1",
          [id],
        );
        if (!remaining.rowCount)
          throw new AppError(
            "last_admin",
            "The last active administrator cannot be disabled.",
            409,
          );
      }
      await client.query(
        "UPDATE metro_profiles SET active = $1, updated_at = now() WHERE user_id = $2",
        [action === "enable", id],
      );
      await revokeUserSessions(client, id);
      if (action === "disable")
        await client.query(
          "UPDATE metro_invitations SET revoked_at = now() WHERE user_id = $1 AND consumed_at IS NULL AND revoked_at IS NULL",
          [id],
        );
      await audit(client, actor.id, `account.${action}`, id);
    });
    return json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}
