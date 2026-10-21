import { z } from "zod";
import { requireUser } from "@/server/auth/authorize";
import { enforceSameOrigin } from "@/server/security";
import { errorResponse, json, readJson } from "@/server/http";
import {
  listNotifications,
  markNotificationsRead,
} from "@/server/operations/notifications";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request): Promise<Response> {
  try {
    const user = await requireUser(request);
    return json(await listNotifications(user.id));
  } catch (error) {
    return errorResponse(error);
  }
}
export async function POST(request: Request): Promise<Response> {
  try {
    enforceSameOrigin(request);
    const user = await requireUser(request);
    const { throughId } = z
      .object({ throughId: z.string().uuid() })
      .strict()
      .parse(await readJson(request, 1024));
    await markNotificationsRead(user.id, throughId);
    return json(await listNotifications(user.id));
  } catch (error) {
    return errorResponse(error);
  }
}
