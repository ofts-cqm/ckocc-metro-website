import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { getPool } from "../src/server/db/pool";

async function main(): Promise<void> {
  const directory = new URL("../migrations/", import.meta.url);
  const files = (await readdir(directory))
    .filter((name) => /^\d+_[a-z0-9_-]+\.sql$/.test(name))
    .sort();
  if (!files.length) throw new Error("No SQL migrations found.");
  const client = await getPool().connect();
  try {
    // A session lock also protects the migration registry's initial creation.
    await client.query("SELECT pg_advisory_lock(2147032000)");
    await client.query(
      "CREATE TABLE IF NOT EXISTS metro_schema_migrations (name text PRIMARY KEY, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())",
    );
    for (const name of files) {
      const sql = await readFile(
        fileURLToPath(new URL(name, directory)),
        "utf8",
      );
      const digest = createHash("sha256").update(sql).digest("hex");
      const previous = await client.query<{ sha256: string }>(
        "SELECT sha256 FROM metro_schema_migrations WHERE name = $1",
        [name],
      );
      if (previous.rows[0]) {
        if (previous.rows[0].sha256 !== digest)
          throw new Error(
            `Applied migration ${name} was modified. Add a new migration instead.`,
          );
        console.log(`Already applied: ${name}`);
        continue;
      }
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
  } finally {
    await client
      .query("SELECT pg_advisory_unlock(2147032000)")
      .catch(() => undefined);
    client.release();
  }
}

main()
  .catch(() => {
    console.error(
      "Database migration failed. Verify DATABASE_URL, database availability, and migration compatibility. Provider details were withheld to protect credentials.",
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await getPool().end();
    } catch {
      /* No initialized pool when configuration is absent. */
    }
  });
