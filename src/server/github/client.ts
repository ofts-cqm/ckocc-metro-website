import { App, Octokit } from "octokit";
import { PipelineError } from "@/server/operations/errors";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new PipelineError("service_not_configured", 503);
  return value;
}

export function repositoryConfig() {
  const owner = required("GITHUB_OWNER");
  const repo = required("GITHUB_REPO");
  const branch =
    process.env.GITHUB_DEFAULT_BRANCH?.trim() ||
    process.env.GITHUB_BASE_BRANCH?.trim() ||
    "main";
  if (
    !/^[\w.-]+$/.test(owner) ||
    !/^[\w.-]+$/.test(repo) ||
    !/^[\w./-]+$/.test(branch)
  ) {
    throw new PipelineError("service_not_configured", 503);
  }
  return { owner, repo, branch, key: `${owner}/${repo}` };
}

/** Disable SDK write retries: operation-specific recovery owns all retries. */
const SafeOctokit = Octokit.defaults({
  request: { timeout: 25_000 },
  retry: { enabled: false },
  throttle: { enabled: false },
});

export async function github() {
  if (process.env.GITHUB_PERSONAL_ACCESS_TOKEN) {
    return new SafeOctokit({ auth: process.env.GITHUB_PERSONAL_ACCESS_TOKEN });
  }
  const app = new App({
    appId: required("GITHUB_APP_ID"),
    privateKey: required("GITHUB_APP_PRIVATE_KEY").replace(/\\n/g, "\n"),
    Octokit: SafeOctokit,
  });
  const installationId = Number(
    process.env.GITHUB_INSTALLATION_ID ||
      required("GITHUB_APP_INSTALLATION_ID"),
  );
  if (!Number.isSafeInteger(installationId) || installationId < 1)
    throw new PipelineError("service_not_configured", 503);
  return app.getInstallationOctokit(installationId);
}

export function expectedBotLogin(): string {
  return required("GITHUB_BOT_LOGIN");
}

export async function currentHead() {
  const client = await github();
  const { owner, repo, branch } = repositoryConfig();
  const repository = await client.rest.repos.get({ owner, repo });
  if (repository.data.default_branch !== branch)
    throw new PipelineError("default_branch_changed", 409);
  const ref = await client.rest.git.getRef({
    owner,
    repo,
    ref: `heads/${branch}`,
  });
  return ref.data.object.sha;
}

export const MAP_PATHS = {
  json: "maps/network.json",
  png: "maps/network.png",
  manifest: "maps/manifest.json",
} as const;

export async function readFileAt(
  commit: string,
  path: (typeof MAP_PATHS)[keyof typeof MAP_PATHS],
  limit: number,
): Promise<Buffer> {
  if (!/^[a-f0-9]{40}$/.test(commit))
    throw new PipelineError("invalid_revision");
  const client = await github();
  const { owner, repo } = repositoryConfig();
  const result = await client.rest.repos.getContent({
    owner,
    repo,
    path,
    ref: commit,
  });
  const file = result.data;
  if (Array.isArray(file) || file.type !== "file" || file.size > limit)
    throw new PipelineError("file_too_large", 413);
  const blob = await client.rest.git.getBlob({
    owner,
    repo,
    file_sha: file.sha,
  });
  if (
    blob.data.size === null ||
    blob.data.size > limit ||
    blob.data.encoding !== "base64"
  )
    throw new PipelineError("invalid_file");
  const data = Buffer.from(blob.data.content, "base64");
  if (data.length > limit || data.length !== blob.data.size)
    throw new PipelineError("invalid_file");
  return data;
}
