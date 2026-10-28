import { z } from "zod";
import { requireUser, requireAdmin } from "@/server/auth/authorize";
import { enforceSameOrigin } from "@/server/security";
import { json } from "@/server/http";
import { route } from "@/server/operations/handlers";
import { reviseUpdate } from "@/server/operations/revise";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Restores an eligible failed map update operation to an editable draft.
// The update workflow invokes this after a submission needs correction.
export const POST = route(async (request, context) => {
  enforceSameOrigin(request);
  const user = await requireUser(request);
  if (user.role === "admin") await requireAdmin(request);
  const id = z.uuid().parse((await context?.params)?.id);
  return json(await reviseUpdate(id, user));
});
