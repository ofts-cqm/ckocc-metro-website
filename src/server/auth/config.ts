import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";
import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { getPool, query } from "@/server/db";
import {
  hashPassword,
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  needsRehash,
  verifyPassword,
} from "./password";

const loginContext = new AsyncLocalStorage<{ verifiedHash?: string }>();
export function withLoginContext<T>(run: () => Promise<T>): Promise<T> {
  return loginContext.run({}, run);
}

export function siteOrigin(): string {
  const raw = process.env.BETTER_AUTH_URL || process.env.APP_URL;
  if (!raw) throw new Error("BETTER_AUTH_URL or APP_URL is required.");
  const url = new URL(raw);
  if (
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error("Auth URL must be an origin.");
  if (process.env.NODE_ENV === "production" && url.protocol !== "https:")
    throw new Error("HTTPS is required for production authentication.");
  return url.origin;
}

function createAuth() {
  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret || secret.length < 32)
    throw new Error("BETTER_AUTH_SECRET must have at least 32 characters.");
  const baseURL = siteOrigin();
  return betterAuth({
    appName: "CKOCC Metro",
    baseURL,
    secret,
    database: getPool(),
    trustedOrigins: [baseURL],
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
      minPasswordLength: MIN_PASSWORD_LENGTH,
      maxPasswordLength: MAX_PASSWORD_LENGTH,
      autoSignIn: false,
      revokeSessionsOnPasswordReset: true,
      password: {
        hash: hashPassword,
        verify: async (input) => {
          const valid = await verifyPassword(input);
          let verifiedHash = input.hash;
          if (valid && needsRehash(input.hash)) {
            const replacement = await hashPassword(input.password);
            // A concurrent password reset must never be overwritten by a login rehash.
            const changed = await query(
              'UPDATE "account" SET password = $1, "updatedAt" = now() WHERE password = $2 AND "providerId" = \'credential\'',
              [replacement, input.hash],
            );
            if (changed.rowCount) verifiedHash = replacement;
          }
          if (valid && loginContext.getStore())
            loginContext.getStore()!.verifiedHash = verifiedHash;
          return valid;
        },
      },
    },
    session: {
      expiresIn: 7 * 24 * 60 * 60,
      updateAge: 24 * 60 * 60,
      freshAge: 15 * 60,
      cookieCache: { enabled: false },
      additionalFields: {
        authVersion: {
          type: "number",
          required: true,
          defaultValue: 1,
          input: false,
          returned: false,
        },
      },
    },
    advanced: {
      useSecureCookies: baseURL.startsWith("https://"),
      defaultCookieAttributes: {
        httpOnly: true,
        sameSite: "lax",
        secure: baseURL.startsWith("https://"),
      },
      // Raw IP addresses are unnecessary in authentication records. Our limiter stores keyed digests.
      ipAddress: { disableIpTracking: true },
    },
    // The route wrapper enforces PostgreSQL-backed account/IP limits, also on development instances.
    rateLimit: { enabled: false },
    databaseHooks: {
      session: {
        create: {
          before: async (session) => {
            const result = await query<{
              active: boolean;
              auth_version: number;
              password: string;
            }>(
              `SELECT p.active, p.auth_version, a.password FROM metro_profiles p JOIN "account" a ON a."userId" = p.user_id AND a."providerId" = 'credential' WHERE p.user_id = $1`,
              [session.userId],
            );
            const profile = result.rows[0];
            // Bind the new session to the exact credential verified in this request. A reset racing
            // the login invalidates either this comparison or the session version on authorization.
            if (
              !profile?.active ||
              profile.password !== loginContext.getStore()?.verifiedHash
            )
              throw new APIError("UNAUTHORIZED", {
                code: "INVALID_EMAIL_OR_PASSWORD",
                message: "Invalid email or password.",
              });
            return { data: { ...session, authVersion: profile.auth_version } };
          },
        },
      },
    },
    logger: { disabled: true },
  });
}

let auth: ReturnType<typeof createAuth> | undefined;
export function getAuth(): ReturnType<typeof createAuth> {
  auth ??= createAuth();
  return auth;
}
