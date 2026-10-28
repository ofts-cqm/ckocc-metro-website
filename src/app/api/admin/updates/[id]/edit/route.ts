import { z } from "zod";
import { requireAdmin } from "@/server/auth/authorize";
import { enforceSameOrigin } from "@/server/security";
import { json } from "@/server/http";
import { route } from "@/server/operations/handlers";
import { beginUpdateEdit } from "@/server/operations/manage-updates";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Starts an edit session for an update under administrator review.
// The admin review workflow invokes this to revise the submitted map.
export const POST = route(async (request, context) => {
  enforceSameOrigin(request);
  const user = await requireAdmin(request);
  return json(
    await beginUpdateEdit(z.uuid().parse((await context?.params)?.id), user),
  );
});
