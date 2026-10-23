import { z } from "zod";
import { requireUser, requireAdmin } from "@/server/auth/authorize";
import { enforceSameOrigin } from "@/server/security";
import { json } from "@/server/http";
import { route } from "@/server/operations/handlers";
import { deleteUpdate } from "@/server/operations/manage-updates";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const DELETE = route(async (request, context) => {
  enforceSameOrigin(request);
  const user = await requireUser(request);
  if (user.role === "admin") await requireAdmin(request);
  await deleteUpdate(z.uuid().parse((await context?.params)?.id), user);
  return json({ deleted: true });
});
