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
// Lists notifications for the signed-in account.
// The inbox workflow invokes this to show unread activity.
export async function GET(request: Request): Promise<Response> {
  try {
    const user = await requireUser(request);
    return json(await listNotifications(user.id));
  } catch (error) {
    return errorResponse(error);
  }
}
// Marks notifications read through a selected notification ID.
// The inbox workflow invokes this and receives the updated list.
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
