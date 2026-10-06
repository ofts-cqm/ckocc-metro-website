import { z } from "zod";
import { getAuth, withLoginContext } from "@/server/auth/config";
import { AppError, errorResponse, readJson } from "@/server/http";
import {
  clearSuccessfulLogin,
  enforceSameOrigin,
  requireLoginAttempt,
} from "@/server/security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const loginSchema = z
  .object({
    email: z.string().trim().email().max(254),
    password: z.string().min(1).max(128),
    rememberMe: z.boolean().optional(),
    callbackURL: z.string().max(2048).optional(),
  })
  .strict();

export async function GET(request: Request): Promise<Response> {
  try {
    if (new URL(request.url).pathname !== "/api/auth/get-session")
      throw new AppError("not_found", "Not found.", 404);
    return await getAuth().handler(request);
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    enforceSameOrigin(request);
    const path = new URL(request.url).pathname;
    // Registration, email changes, self-service resets, and plugin administration are deliberately
    // absent. Invited accounts are created atomically through the separate invitation adapter.
    if (path === "/api/auth/sign-in/email") {
      const body = loginSchema.parse(await readJson(request, 8 * 1024));
      await requireLoginAttempt(request, body.email);
      const forwarded = new Request(request.url, {
        method: "POST",
        headers: request.headers,
        body: JSON.stringify({ ...body, email: body.email.toLowerCase() }),
      });
      const response = await withLoginContext(() =>
        getAuth().handler(forwarded),
      );
      if (!response.ok)
        throw new AppError(
          "invalid_credentials",
          "Invalid email or password.",
          401,
        );
      await clearSuccessfulLogin(request, body.email);
      response.headers.set("Cache-Control", "no-store");
      return response;
    }
    if (path === "/api/auth/sign-out") {
      await readJson(request, 1024);
      return await getAuth().handler(
        new Request(request.url, {
          method: "POST",
          headers: request.headers,
          body: "{}",
        }),
      );
    }
    throw new AppError("not_found", "Not found.", 404);
  } catch (error) {
    return errorResponse(error);
  }
}
