import { readFile } from "node:fs/promises";
import { parseArgs, parseEnv } from "node:util";
import { Pool } from "pg";
import { reconcileOperations } from "./lib/reconcile-operations";

let pool: Pool | undefined;
async function main() {
  const { values } = parseArgs({
    options: {
      prod: { type: "boolean" },
      apply: { type: "boolean" },
      repository: { type: "string" },
      branch: { type: "string", default: "main" },
      "github-env": { type: "string" },
      help: { type: "boolean" },
    },
  });
  if (values.help) {
    console.log(
      "Usage: npm run ops:reconcile -- --repository OWNER/REPO [--prod] [--github-env FILE] [--branch main] [--apply]\nDefault: read-only preview. --prod reads only PRODUCTION_DATABASE_URL from .env.prod-migrations or the shell. Local mode requires DATABASE_URL in the shell. Optional --github-env imports only GitHub credentials and bot identity. All operation rows are scanned; unsupported/uncertain cases remain unresolved. No GitHub, Blob, workflow, or email writes.",
    );
    return;
  }
  if (!values.repository || !/^[\w.-]+\/[\w.-]+$/.test(values.repository))
    throw new Error("invalid_repository");
  let connection: string | undefined;
  if (values.prod) {
    const env: Record<string, string | undefined> = await readFile(
      ".env.prod-migrations",
      "utf8",
    )
      .then(parseEnv)
      .catch((e) => {
        if (e.code === "ENOENT") return {};
        throw e;
      });
    connection =
      process.env.PRODUCTION_DATABASE_URL || env.PRODUCTION_DATABASE_URL;
  } else connection = process.env.DATABASE_URL;
  if (!connection) throw new Error("missing_database_connection");
  if (values["github-env"]) {
    const env = parseEnv(await readFile(values["github-env"], "utf8"));
    for (const key of [
      "GITHUB_APP_ID",
      "GITHUB_APP_PRIVATE_KEY",
      "GITHUB_INSTALLATION_ID",
      "GITHUB_APP_INSTALLATION_ID",
      "GITHUB_PERSONAL_ACCESS_TOKEN",
      "GITHUB_BOT_LOGIN",
    ])
      if (env[key]) process.env[key] = env[key];
  }
  // Explicit target prevents local test repository settings selecting production rows.
  [process.env.GITHUB_OWNER, process.env.GITHUB_REPO] =
    values.repository.split("/");
  process.env.GITHUB_DEFAULT_BRANCH = values.branch;
  const url = new URL(connection);
  if (!["postgres:", "postgresql:"].includes(url.protocol))
    throw new Error("invalid_database_connection");
  // Preserve the pg client's existing verified-TLS semantics explicitly.
  if (
    ["require", "prefer", "verify-ca"].includes(
      url.searchParams.get("sslmode") ?? "",
    )
  )
    url.searchParams.set("sslmode", "verify-full");
  if (!values.apply)
    url.searchParams.set(
      "options",
      `${url.searchParams.get("options") || ""} -c default_transaction_read_only=on`.trim(),
    );
  pool = new Pool({
    connectionString: url.toString(),
    max: 2,
    connectionTimeoutMillis: 10000,
    statement_timeout: 30000,
  });
  pool.on("error", () =>
    console.error("Database connection failed; provider details withheld."),
  );
  console.log(
    JSON.stringify({
      target: values.prod ? "production" : "DATABASE_URL",
      repository: values.repository,
      branch: values.branch,
      mode: values.apply ? "apply" : "preview",
    }),
  );
  // Dynamic ESM import keeps this standalone CLI compatible with Octokit's
  // ESM-only dependencies even though this repository is not type:module.
  const github = async () => {
    const { App, Octokit } = await import("octokit");
    const SafeOctokit = Octokit.defaults({
      request: { timeout: 25_000 },
      retry: { enabled: false },
      throttle: { enabled: false },
    });
    if (process.env.GITHUB_PERSONAL_ACCESS_TOKEN)
      return new SafeOctokit({
        auth: process.env.GITHUB_PERSONAL_ACCESS_TOKEN,
      });
    const app = new App({
      appId: process.env.GITHUB_APP_ID || "",
      privateKey: (process.env.GITHUB_APP_PRIVATE_KEY || "").replace(
        /\\n/g,
        "\n",
      ),
      Octokit: SafeOctokit,
    });
    return app.getInstallationOctokit(
      Number(
        process.env.GITHUB_INSTALLATION_ID ||
          process.env.GITHUB_APP_INSTALLATION_ID,
      ),
    );
  };
  const summary = await reconcileOperations(
    pool,
    {
      repository: values.repository,
      branch: values.branch!,
      bot: process.env.GITHUB_BOT_LOGIN || "",
      readPull: async (number) => {
        const client = await github();
        const [owner, repo] = values.repository!.split("/");
        const { data } = await client.rest.pulls.get({
          owner,
          repo,
          pull_number: number,
        });
        return {
          number: data.number,
          state: data.state,
          merged: data.merged,
          mergedAt: data.merged_at,
          mergeCommitSha: data.merge_commit_sha,
          repository: data.base.repo.full_name,
          creator: data.user?.login ?? "",
        };
      },
    },
    !!values.apply,
    (entry) => console.log(JSON.stringify(entry)),
  );
  console.log(JSON.stringify(summary));
  if (summary.unresolved || summary.raced) process.exitCode = 2;
}
main()
  .catch(() => {
    console.error(
      "Reconciliation failed. Check arguments (--help), database access and GitHub configuration. Provider details withheld to protect credentials.",
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool?.end();
  });
