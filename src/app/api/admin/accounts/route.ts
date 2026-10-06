import { requireAdmin } from "@/server/auth/authorize";
import { query } from "@/server/db";
import { errorResponse, json } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request): Promise<Response> {
  try {
    await requireAdmin(request, { fresh: false });
    const accounts = await query(
      'SELECT u.id, u.email, u.name, p.role, p.active, u."createdAt" FROM "user" u JOIN metro_profiles p ON p.user_id = u.id ORDER BY u."createdAt" DESC LIMIT 500',
    );
    return json({ accounts: accounts.rows });
  } catch (error) {
    return errorResponse(error);
  }
}
