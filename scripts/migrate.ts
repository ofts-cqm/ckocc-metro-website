import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { getPool } from "../src/server/db/pool";

class MigrationError extends Error {}
const emailMigrations = [
  "003_email_notifications.sql",
  "004_email_daily_limit.sql",
];
const prerequisites = ["001_accounts.sql", "002_pipeline.sql"];
let connected = false;

/** Checks applied SQL digests and runs pending migrations under a DB lock.
 * db:migrate and the explicit production email migration command invoke it. */
async function main(): Promise<void> {
  // Select the requested database and read all migration files before connecting.
  const args = process.argv.slice(2);
  if (args.some((arg) => !["--email-prod", "--check"].includes(arg)))
    throw new MigrationError(
      "Unknown argument. Supported options: --email-prod, --check.",
    );
  const emailProd = args.includes("--email-prod");
  const checkOnly = args.includes("--check");
  if (emailProd) {
    const connection = process.env.PRODUCTION_DATABASE_URL?.trim();
    if (!connection)
      throw new MigrationError(
        "PRODUCTION_DATABASE_URL is required. Set it in your shell or .env.prod-migrations. DATABASE_URL is never used as a fallback by this command.",
      );
    let url: URL;
    try {
      url = new URL(connection);
    } catch {
      throw new MigrationError(
        "PRODUCTION_DATABASE_URL must be a PostgreSQL connection URL.",
      );
    }
    if (
      !["postgres:", "postgresql:"].includes(url.protocol) ||
      !url.hostname ||
      url.pathname.length < 2
    )
      throw new MigrationError(
        "PRODUCTION_DATABASE_URL must include a PostgreSQL host and database name.",
      );
    process.env.DATABASE_URL = connection;
  }
  const directory = new URL("../migrations/", import.meta.url);
  const files = emailProd
    ? emailMigrations
    : (await readdir(directory))
        .filter((name) => /^\d+_[a-z0-9_-]+\.sql$/.test(name))
        .sort();
  if (!files.length) throw new MigrationError("No SQL migrations found.");
  const inspected = [...(emailProd ? prerequisites : []), ...files];
  const migrations = new Map<string, { sql: string; digest: string }>();
  for (const name of inspected) {
    const sql = await readFile(fileURLToPath(new URL(name, directory)), "utf8");
    migrations.set(name, {
      sql,
      digest: createHash("sha256").update(sql).digest("hex"),
    });
  }
  const client = await getPool().connect();
  connected = true;
  try {
    // A direct connection is required: this lock spans migration transactions.
    await client.query("SELECT pg_advisory_lock(2147032000)");
    const registry = await client.query<{ present: boolean }>(
      "SELECT to_regclass('metro_schema_migrations') IS NOT NULL AS present",
    );
    if (emailProd && !registry.rows[0].present)
      throw new MigrationError(
        "Migration registry is missing. Apply baseline migrations 001 and 002 before preparing the email schema.",
      );
    const applied = registry.rows[0].present
      ? (
          await client.query<{ name: string; sha256: string }>(
            "SELECT name,sha256 FROM metro_schema_migrations",
          )
        ).rows
      : [];
    const previous = new Map(applied.map((row) => [row.name, row.sha256]));
    // Preflight every required/selected checksum before making any schema changes.
    for (const name of inspected) {
      const digest = previous.get(name);
      if (digest && digest !== migrations.get(name)!.digest)
        throw new MigrationError(
          `Applied migration ${name} was modified. Add a new migration instead.`,
        );
      if (emailProd && prerequisites.includes(name) && !digest)
        throw new MigrationError(
          `Required baseline migration ${name} has not been applied. No email migrations were applied.`,
        );
    }
    if (emailProd)
      console.log(
        "Target: email migrations 003 and 004 using PRODUCTION_DATABASE_URL.",
      );
    if (!registry.rows[0].present && !checkOnly)
      await client.query(
        "CREATE TABLE metro_schema_migrations (name text PRIMARY KEY, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())",
      );
    let pending = 0;
    // Apply each pending migration and its registry entry in one transaction.
    for (const name of files) {
      if (previous.has(name)) {
        console.log(`Already applied: ${name}`);
        continue;
      }
      pending++;
      if (checkOnly) {
        console.log(`Pending: ${name}`);
        continue;
      }
      const { sql, digest } = migrations.get(name)!;
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query(
          "INSERT INTO metro_schema_migrations (name, sha256) VALUES ($1, $2)",
          [name, digest],
        );
        await client.query("COMMIT");
        console.log(`Applied: ${name}`);
      } catch (error) {
        await client.query("ROLLBACK");
        console.error(`Migration failed: ${name}`);
        throw error;
      }
    }
    if (checkOnly)
      console.log(
        `Check complete: ${pending} pending migration(s). No schema changes made.`,
      );
  } finally {
    await client
      .query("SELECT pg_advisory_unlock(2147032000)")
      .catch(() => undefined);
    client.release();
  }
}

main()
  .catch((error) => {
    console.error(
      error instanceof MigrationError
        ? error.message
        : "Database migration failed. Verify the configured database URL, database availability, and migration compatibility. Provider details were withheld to protect credentials.",
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    if (connected)
      await getPool()
        .end()
        .catch(() => undefined);
  });
