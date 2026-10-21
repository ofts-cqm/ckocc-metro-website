import { requireUser } from "@/server/auth/authorize";
import {
  emailSettings,
  preferencesSchema,
  setEmailPreferences,
} from "@/server/email/accounts";
import { errorResponse, json, readJson } from "@/server/http";
import { enforceSameOrigin } from "@/server/security";
export const runtime = "nodejs";
export async function GET(request: Request) {
  try {
    return json({
      preferences: await emailSettings((await requireUser(request)).id),
    });
  } catch (error) {
    return errorResponse(error);
  }
}
export async function POST(request: Request) {
  try {
    enforceSameOrigin(request);
    const user = await requireUser(request);
    await setEmailPreferences(
      user.id,
      preferencesSchema.parse(await readJson(request, 2048)),
    );
    return json({ preferences: await emailSettings(user.id) });
  } catch (error) {
    return errorResponse(error);
  }
}
