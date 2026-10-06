import { requireAdmin } from "@/server/auth/authorize";
import { createInvitation, invitationSchema } from "@/server/auth/invitations";
import { query } from "@/server/db";
import { errorResponse, json, readJson } from "@/server/http";
import { enforceSameOrigin } from "@/server/security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request): Promise<Response> {
  try {
    await requireAdmin(request, { fresh: false });
    const result = await query(
      'SELECT id, kind, email, display_name AS "displayName", role, expires_at AS "expiresAt", consumed_at AS "consumedAt", revoked_at AS "revokedAt" FROM metro_invitations ORDER BY created_at DESC LIMIT 100',
    );
    return json({ invitations: result.rows });
  } catch (error) {
    return errorResponse(error);
  }
}
export async function POST(request: Request): Promise<Response> {
  try {
    enforceSameOrigin(request);
    const actor = await requireAdmin(request);
    const invitation = await createInvitation(
      actor.id,
      invitationSchema.parse(await readJson(request, 8 * 1024)),
    );
    return json({ invitation }, 201);
  } catch (error) {
    return errorResponse(error);
  }
}
