/** Exercise the production npm command against isolated LOCAL schemas only. */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { Client } from "pg";

async function run(env: NodeJS.ProcessEnv, args: string[] = [], npm = true) {
  return await new Promise<{ code: number | null; output: string }>(
    (resolve, reject) => {
      const child = spawn(
        npm ? "npm" : process.execPath,
        npm
          ? ["run", "db:migrate:email:prod", "--", ...args]
          : ["--import", "tsx", "scripts/migrate.ts", "--email-prod", ...args],
        { env, stdio: ["ignore", "pipe", "pipe"] },
      );
      let output = "";
      child.stdout.on("data", (chunk) => {
        output += chunk;
      });
      child.stderr.on("data", (chunk) => {
        output += chunk;
      });
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, output }));
    },
  );
}

async function main() {
  const raw = process.env.EMAIL_TEST_DATABASE_URL || process.env.DATABASE_URL;
  assert(raw, "A local test/dev database URL is required.");
  const url = new URL(raw);
  assert(
    ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) &&
      /(test|dev)/i.test(url.pathname),
    "Only a local test/dev database may be used.",
  );
  const admin = new Client({ connectionString: raw });
  await admin.connect();
  const schema = `email_migrate_${randomUUID().replaceAll("-", "")}`;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DATABASE_URL: "postgresql://invalid:invalid@127.0.0.1:1/not_used",
  };
  // Without the separate production variable the command must fail before connecting.
  delete env.PRODUCTION_DATABASE_URL;
  const missing = await run(env, ["--check"], false);
  assert.equal(missing.code, 1);
  assert.match(missing.output, /PRODUCTION_DATABASE_URL is required/);
  await admin.query(`CREATE SCHEMA ${schema}`);
  await admin.query(`SET search_path TO ${schema}`);
  const target = new URL(raw);
  target.searchParams.set("options", `-c search_path=${schema}`);
  env.PRODUCTION_DATABASE_URL = target.toString();
  const registry = () =>
    admin.query<{ name: string }>(
      "SELECT name FROM metro_schema_migrations ORDER BY name",
    );
  try {
    const absent = await run(env, ["--check"]);
    assert.equal(absent.code, 1);
    assert.match(absent.output, /Migration registry is missing/);
    assert.equal(
      (
        await admin.query(
          "SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema=$1",
          [schema],
        )
      ).rows[0].n,
      0,
    );
    await admin.query(
      "CREATE TABLE metro_schema_migrations(name text PRIMARY KEY,sha256 text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())",
    );
    for (const name of ["001_accounts.sql", "002_pipeline.sql"]) {
      const sql = await readFile(`migrations/${name}`, "utf8");
      await admin.query(sql);
      await admin.query(
        "INSERT INTO metro_schema_migrations(name,sha256) VALUES($1,$2)",
        [name, createHash("sha256").update(sql).digest("hex")],
      );
    }
    const check = await run(env, ["--check"]);
    assert.equal(check.code, 0, check.output);
    assert.match(check.output, /2 pending migration/);
    assert.equal((await registry()).rowCount, 2);
    assert.equal(
      (
        await admin.query(
          "SELECT to_regclass('metro_email_jobs') AS table_name",
        )
      ).rows[0].table_name,
      null,
      "--check must not create email tables",
    );
    // A conflicting fixture table makes 004 fail after 003 commits.
    await admin.query("CREATE TABLE metro_email_daily_slots(blocked boolean)");
    const partial = await run(env);
    assert.equal(partial.code, 1);
    assert.match(partial.output, /Applied: 003_email_notifications.sql/);
    assert.match(partial.output, /Migration failed: 004_email_daily_limit.sql/);
    assert.equal((await registry()).rowCount, 3);
    await admin.query("DROP TABLE metro_email_daily_slots");
    const apply = await run(env);
    assert.equal(apply.code, 0, apply.output);
    assert.match(apply.output, /Already applied: 003_email_notifications.sql/);
    assert.match(apply.output, /Applied: 004_email_daily_limit.sql/);
    assert.deepEqual(
      (await registry()).rows.map((r) => r.name),
      [
        "001_accounts.sql",
        "002_pipeline.sql",
        "003_email_notifications.sql",
        "004_email_daily_limit.sql",
      ],
    );
    const cutoff = (
      await admin.query("SELECT launch_cutoff::text FROM metro_email_state")
    ).rows[0].launch_cutoff;
    const rerun = await run(env);
    assert.equal(rerun.code, 0, rerun.output);
    assert.doesNotMatch(rerun.output, /^Applied:/m);
    const done = await run(env, ["--check"]);
    assert.equal(done.code, 0, done.output);
    assert.match(done.output, /0 pending migration/);
    assert.equal(
      (await admin.query("SELECT launch_cutoff::text FROM metro_email_state"))
        .rows[0].launch_cutoff,
      cutoff,
    );
    // Refuse a modified baseline before applying any email changes.
    await admin.query(
      "UPDATE metro_schema_migrations SET sha256='wrong' WHERE name='001_accounts.sql'",
    );
    const mismatch = await run(env);
    assert.equal(mismatch.code, 1);
    assert.match(
      mismatch.output,
      /Applied migration 001_accounts.sql was modified/,
    );
    assert.equal((await registry()).rowCount, 4);
    assert(
      ![missing, absent, check, partial, apply, rerun, done, mismatch].some(
        (r) => r.output.includes(target.toString()),
      ),
      "Never print the database URL",
    );
    console.log(
      "PASS: explicit production URL, no fallback, baseline validation, read-only check, migrations 003/004, failed-004 recovery, idempotent rerun, checksum refusal, no credential output. Production was not contacted.",
    );
  } finally {
    await admin.query("SET search_path TO public");
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
}
main().catch((error) => {
  console.error(
    error instanceof Error ? error.message : "Migration test failed",
  );
  process.exitCode = 1;
});
