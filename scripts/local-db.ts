import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { userInfo } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { Client } from "pg";

const root = fileURLToPath(new URL("../", import.meta.url));
const directory = path.join(root, ".local/postgres");
const data = path.join(directory, "data");
const socket = path.join(directory, "run");
const logfile = path.join(directory, "server.log");
const statefile = path.join(directory, "connection.json");
const envfile = path.join(root, ".env.local");
type State = { port: number; password: string; administrator: string };

async function exists(filename: string) {
  try {
    await stat(filename);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
function command(program: string, args: string[], quiet = false) {
  const result = spawnSync(program, args, {
    cwd: root,
    encoding: "utf8",
    stdio: quiet ? "pipe" : "inherit",
  });
  if (result.error || result.status !== 0)
    throw new Error(
      `${program} failed. Check PostgreSQL binaries and the project-local server log.`,
    );
}
function running() {
  return (
    spawnSync("pg_ctl", ["-D", data, "status"], { stdio: "ignore" }).status ===
    0
  );
}
function connection(state: State) {
  return `postgresql://ckocc_metro:${state.password}@127.0.0.1:${state.port}/ckocc_metro_dev`;
}
async function readState(): Promise<State> {
  const value = JSON.parse(await readFile(statefile, "utf8")) as State;
  if (
    !Number.isInteger(value.port) ||
    value.port < 1024 ||
    value.port > 65535 ||
    !/^[a-f0-9]{64}$/.test(value.password) ||
    value.administrator !== userInfo().username
  ) {
    throw new Error(
      "Local database configuration is invalid or belongs to another operating-system user.",
    );
  }
  return value;
}
async function start() {
  if (!(await exists(path.join(data, "PG_VERSION"))))
    throw new Error("Run npm run db:local:init first.");
  await mkdir(socket, { recursive: true, mode: 0o700 });
  if (!running())
    command("pg_ctl", ["-D", data, "-l", logfile, "-w", "-t", "30", "start"]);
}

async function initialize() {
  if (process.getuid?.() === 0)
    throw new Error(
      "Run local database setup as your regular operating-system user.",
    );
  const previousEnv = (await exists(envfile))
    ? await readFile(envfile, "utf8")
    : "";
  const previousState = (await exists(statefile)) ? await readState() : null;
  const configured = parseEnv(previousEnv).DATABASE_URL;
  if (
    configured &&
    (!previousState || configured !== connection(previousState))
  )
    throw new Error(
      ".env.local already targets another database. Local setup will not replace it.",
    );
  if ((await exists(data)) && !previousState)
    throw new Error(
      "An unmanaged local data directory exists; refusing to initialize over it.",
    );
  const port = Number(process.env.METRO_DB_PORT || "5433");
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    throw new Error("METRO_DB_PORT must be between 1024 and 65535.");
  const state: State = previousState ?? {
    port,
    password: randomBytes(32).toString("hex"),
    administrator: userInfo().username,
  };
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  if (!previousState)
    await writeFile(statefile, JSON.stringify(state), {
      flag: "wx",
      mode: 0o600,
    });
  await mkdir(socket, { recursive: true, mode: 0o700 });
  if (!(await exists(path.join(data, "PG_VERSION")))) {
    command("initdb", [
      "-D",
      data,
      "--username",
      state.administrator,
      "--auth-local=peer",
      "--auth-host=scram-sha-256",
      "--encoding=UTF8",
      "--locale=C.UTF-8",
      "--no-instructions",
    ]);
  }
  // All addresses are local. Socket paths are trusted filesystem paths, quoted for PostgreSQL.
  const quotedSocket = socket.replaceAll("'", "''");
  await writeFile(
    path.join(data, "postgresql.auto.conf"),
    [
      "# Managed by scripts/local-db.ts; local development only.",
      "listen_addresses = '127.0.0.1'",
      `port = ${state.port}`,
      `unix_socket_directories = '${quotedSocket}'`,
      "unix_socket_permissions = 0700",
      "password_encryption = 'scram-sha-256'",
      "max_connections = 30",
      "shared_buffers = '64MB'",
      "log_statement = 'none'",
      "log_min_error_statement = 'panic'",
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  await start();
  const admin = new Client({
    host: socket,
    port: state.port,
    user: state.administrator,
    database: "postgres",
    connectionTimeoutMillis: 10_000,
  });
  try {
    await admin.connect();
    const role = await admin.query(
      "SELECT 1 FROM pg_roles WHERE rolname='ckocc_metro'",
    );
    if (!role.rowCount) {
      // Password contains only generated hex; neither the SQL nor secret is printed.
      await admin.query(
        `CREATE ROLE ckocc_metro LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD '${state.password}'`,
      );
    }
    const database = await admin.query(
      "SELECT 1 FROM pg_database WHERE datname='ckocc_metro_dev'",
    );
    if (!database.rowCount)
      await admin.query(
        "CREATE DATABASE ckocc_metro_dev OWNER ckocc_metro ENCODING 'UTF8'",
      );
    await admin.query("REVOKE ALL ON DATABASE ckocc_metro_dev FROM PUBLIC");
  } catch {
    throw new Error(
      "Local database provisioning failed; connection and credential details were withheld.",
    );
  } finally {
    await admin.end();
  }
  // Verify the password and TCP connection before selecting this database for the app.
  const client = new Client({
    connectionString: connection(state),
    connectionTimeoutMillis: 10_000,
  });
  try {
    await client.connect();
    await client.query("SELECT 1");
  } catch {
    throw new Error(
      "Local application connection failed; .env.local was not changed.",
    );
  } finally {
    await client.end();
  }
  if (!configured) {
    const withoutEmpty = previousEnv.replace(
      /^\s*(?:export\s+)?DATABASE_URL\s*=.*(?:\r?\n|$)/gm,
      "",
    );
    await writeFile(
      envfile,
      `${withoutEmpty}${withoutEmpty && !withoutEmpty.endsWith("\n") ? "\n" : ""}# Project-local PostgreSQL (generated; do not commit).\nDATABASE_URL=${connection(state)}\n`,
      { mode: 0o600 },
    );
  }
  await chmod(envfile, 0o600);
  console.log(
    `Local database ready: 127.0.0.1:${state.port}/ckocc_metro_dev (role: ckocc_metro).`,
  );
  console.log(
    "Credentials saved privately in .env.local. Next: npm run db:migrate.",
  );
}

async function main() {
  switch (process.argv[2]) {
    case "init":
      await initialize();
      break;
    case "start":
      await readState();
      await start();
      break;
    case "stop":
      if (running())
        command("pg_ctl", ["-D", data, "-m", "fast", "-w", "-t", "30", "stop"]);
      else console.log("Local PostgreSQL is stopped.");
      break;
    case "status":
      console.log(`Local PostgreSQL is ${running() ? "running" : "stopped"}.`);
      break;
    default:
      throw new Error("Usage: local-db.ts init|start|stop|status");
  }
}
main().catch((error) => {
  console.error(
    error instanceof Error ? error.message : "Local database setup failed.",
  );
  process.exitCode = 1;
});
