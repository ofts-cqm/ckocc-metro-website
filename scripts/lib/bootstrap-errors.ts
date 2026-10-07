export type BootstrapStage =
  | "reading account details"
  | "checking the database"
  | "reading the password"
  | "hashing the password"
  | "saving the administrator";

const messages = {
  terminal: "Run npm run admin:bootstrap in an interactive terminal.",
  email: "Enter a valid email address of at most 254 characters.",
  name: "The display name must contain 1–64 characters and no control characters.",
  password: `The password must contain ${MIN_PASSWORD_LENGTH}–${MAX_PASSWORD_LENGTH} characters.`,
  confirmation:
    "Passwords do not match. Enter the same password twice; spaces count.",
  cancelled: "Cancelled; no administrator was created.",
  configured: "DATABASE_URL is missing. Configure it in .env.local first.",
  existing: "An administrator already exists. Sign in or use account recovery.",
} as const;

export class BootstrapError extends Error {
  constructor(readonly reason: keyof typeof messages) {
    super(messages[reason]);
  }
}

const databaseErrors: Record<string, string> = {
  ECONNREFUSED:
    "PostgreSQL is not accepting connections. For the project-local database, run npm run db:local:start, then retry.",
  ENOTFOUND: "The database hostname could not be resolved. Check DATABASE_URL.",
  EAI_AGAIN: "The database hostname could not be resolved. Check DATABASE_URL.",
  ETIMEDOUT:
    "The database connection timed out. Check that PostgreSQL is running and reachable.",
  EPERM:
    "Database access was denied by the execution environment. Run the command in your local terminal.",
  EACCES:
    "Database access was denied by the execution environment. Run the command in your local terminal.",
  "28P01": "PostgreSQL rejected the database credentials. Check DATABASE_URL.",
  "28000":
    "PostgreSQL rejected database authentication. Check the database access configuration.",
  "3D000": "The configured database does not exist. Check DATABASE_URL.",
  "42P01":
    "The account schema is missing. Run npm run db:migrate against the same database, then retry.",
  "42703":
    "The account schema is incomplete. Run npm run db:migrate against the same database, then retry.",
  "42501":
    "The database role lacks permission to read or create accounts. Check its database privileges.",
  "23505":
    "An account already uses this email. Use a different email or recover the existing account.",
  "57P03":
    "PostgreSQL is starting or recovering. Wait until it is ready, then retry.",
  ERR_INVALID_URL:
    "DATABASE_URL is not a valid connection URL. Check .env.local.",
};

/** Never include raw provider errors, SQL, submitted values, or connection strings. */
export function bootstrapFailureMessage(
  error: unknown,
  stage: BootstrapStage,
): string {
  if (error instanceof BootstrapError)
    return `Administrator bootstrap failed: ${messages[error.reason]}`;
  const code =
    error && typeof error === "object" && "code" in error
      ? error.code
      : undefined;
  const hint =
    typeof code === "string" && Object.hasOwn(databaseErrors, code)
      ? `${databaseErrors[code]} (${code})`
      : "Unexpected failure; credential and provider details were withheld.";
  return `Administrator bootstrap failed while ${stage}: ${hint}`;
}
import {
  MIN_PASSWORD_LENGTH,
  MAX_PASSWORD_LENGTH,
} from "../../src/lib/password-policy";
