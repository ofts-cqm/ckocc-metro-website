import { z } from "zod";
import { requireAdmin } from "@/server/auth/authorize";
import { audit } from "@/server/auth/invitations";
import { query, transaction } from "@/server/db";
import { errorResponse, json, readJson } from "@/server/http";
import { enforceSameOrigin } from "@/server/security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request): Promise<Response> {
  try {
    await requireAdmin(request, { fresh: false });
    const result = await query<{ public_writes_paused: boolean }>(
      "SELECT public_writes_paused FROM metro_settings WHERE singleton = true",
    );
    return json({
      publicWritesPaused: result.rows[0]?.public_writes_paused ?? true,
    });
  } catch (error) {
    return errorResponse(error);
  }
}
export async function PATCH(request: Request): Promise<Response> {
  try {
    enforceSameOrigin(request);
    const actor = await requireAdmin(request);
    const input = z
      .object({ publicWritesPaused: z.boolean() })
      .strict()
      .parse(await readJson(request, 1024));
    await transaction(async (client) => {
      await client.query(
        "UPDATE metro_settings SET public_writes_paused = $1, updated_at = now() WHERE singleton = true",
        [input.publicWritesPaused],
      );
      await audit(
        client,
        actor.id,
        input.publicWritesPaused
          ? "public_writes.pause"
          : "public_writes.resume",
        "settings",
      );
    });
    return json(input);
  } catch (error) {
    return errorResponse(error);
  }
}
