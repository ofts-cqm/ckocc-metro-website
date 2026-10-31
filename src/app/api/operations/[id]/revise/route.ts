import { z } from "zod";
import { requireCollaborator, requireAdmin } from "@/server/auth/authorize";
import { enforceSameOrigin } from "@/server/security";
import { json } from "@/server/http";
import { route } from "@/server/operations/handlers";
import { reviseUpdate } from "@/server/operations/revise";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const POST = route(async (request, context) => {
  enforceSameOrigin(request);
  const user = await requireCollaborator(request);
  if (user.role === "admin") await requireAdmin(request);
  const id = z.uuid().parse((await context?.params)?.id);
  return json(await reviseUpdate(id, user));
});
