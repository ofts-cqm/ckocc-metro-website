import { requireAdmin } from "@/server/auth/authorize";
import { lockIdentityStore } from "@/server/auth/credentials";
import { audit } from "@/server/auth/invitations";
import { transaction } from "@/server/db";
import { AppError, errorResponse, json } from "@/server/http";
import { enforceSameOrigin } from "@/server/security";

export const runtime = "nodejs";
export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    enforceSameOrigin(request);
    const actor = await requireAdmin(request);
    const { id } = await context.params;
    if (!/^[a-f0-9-]{36}$/i.test(id))
      throw new AppError("not_found", "Invitation not found.", 404);
    await transaction(async (client) => {
      await lockIdentityStore(client);
      const result = await client.query(
        "UPDATE metro_invitations SET revoked_at = now() WHERE id = $1 AND consumed_at IS NULL AND revoked_at IS NULL",
        [id],
      );
      if (!result.rowCount)
        throw new AppError("not_found", "Unused invitation not found.", 404);
      await audit(client, actor.id, "invitation.revoke", id);
    });
    return json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}
