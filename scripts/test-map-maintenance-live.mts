/** Opt-in live test on the dedicated map-test repo; never merges or updates main. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { mock } from "node:test";
import { Client } from "pg";
import { App, Octokit } from "octokit";

async function main() {
  if (!process.argv.includes("--live"))
    throw new Error("Pass --live for the dedicated test repository.");
  const owner = process.env.GITHUB_OWNER,
    repo = process.env.GITHUB_REPO;
  if (owner !== "ofts-cqm" || repo !== "ckocc-metro-map-test")
    throw new Error("Dedicated map-test repository required.");
  const connection = process.env.DATABASE_URL;
  if (!connection) throw new Error("Local test database required.");
  const dbUrl = new URL(connection);
  if (
    !["localhost", "127.0.0.1", "[::1]"].includes(dbUrl.hostname) ||
    !/dev|test/i.test(dbUrl.pathname)
  )
    throw new Error("Local development/test database required.");
  if (process.env.GITHUB_PERSONAL_ACCESS_TOKEN)
    throw new Error(
      "Use the narrowly scoped runtime GitHub App for this test.",
    );
  const app = new App({
    appId: process.env.GITHUB_APP_ID!,
    privateKey: process.env.GITHUB_APP_PRIVATE_KEY!.replace(/\\n/g, "\n"),
    Octokit: Octokit.defaults({
      retry: { enabled: false },
      throttle: { enabled: false },
      request: { timeout: 25000 },
    }),
  });
  const github = await app.getInstallationOctokit(
    Number(
      process.env.GITHUB_INSTALLATION_ID ||
        process.env.GITHUB_APP_INSTALLATION_ID,
    ),
  );
  const paths = {
    json: "maps/network.json",
    png: "maps/network.png",
    manifest: "maps/manifest.json",
  } as const;
  const currentHead = async () =>
    (await github.rest.git.getRef({ owner, repo, ref: "heads/main" })).data
      .object.sha;
  async function readFileAt(ref: string, path: string) {
    const result = await github.rest.repos.getContent({
      owner,
      repo,
      path,
      ref,
    });
    if (Array.isArray(result.data) || result.data.type !== "file")
      throw new Error("Expected repository file.");
    const blob = await github.rest.git.getBlob({
      owner,
      repo,
      file_sha: result.data.sha,
    });
    return Buffer.from(blob.data.content, "base64");
  }
  mock.module("../src/server/github/client.ts", {
    namedExports: {
      github: async () => github,
      repositoryConfig: () => ({
        owner,
        repo,
        branch: "main",
        key: `${owner}/${repo}`,
      }),
      expectedBotLogin: () => process.env.GITHUB_BOT_LOGIN,
      currentHead,
      readFileAt,
      MAP_PATHS: paths,
    },
  });
  mock.module("../src/server/auth/config.ts", {
    namedExports: {
      getAuth: () => {
        throw new Error("No browser auth in live acceptance.");
      },
    },
  });
  mock.module("../src/server/email/jobs.ts", {
    namedExports: {
      enqueueOperationEmails: async () => 0,
      launchPendingEmailJobs: async () => 0,
    },
  });
  const admin = new Client({ connectionString: connection });
  await admin.connect();
  const schema = `maintenance_live_${randomUUID().replaceAll("-", "")}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  dbUrl.searchParams.set("options", `-c search_path=${schema}`);
  process.env.DATABASE_URL = dbUrl.toString();
  const { query, getPool } = await import("../src/server/db/index.ts");
  const { validatePair } = await import("../src/server/maps/validate.ts");
  const { processMaintenanceSync } =
    await import("../src/server/operations/maintenance.ts");
  const { acceptOperation, leaseOperation, finishOperation } =
    await import("../src/server/operations/store.ts");
  const report: Record<string, unknown> = {
    repository: `${owner}/${repo}`,
    mainUnchanged: false,
  };
  let branch: string | undefined, prNumber: number | undefined;
  try {
    for (const name of ["001_accounts.sql", "002_pipeline.sql"])
      await query(await readFile(`migrations/${name}`, "utf8"));
    const main = await currentHead();
    const currentManifest = JSON.parse(
      (await readFileAt(main, paths.manifest)).toString(),
    );
    const history = await github.rest.repos.listCommits({
      owner,
      repo,
      sha: main,
      path: paths.manifest,
      per_page: 100,
    });
    const historic = history.data.find((commit) => commit.sha !== main)?.sha;
    if (!historic)
      throw new Error(
        "No historical map commit; refusing to manufacture maintenance on main.",
      );
    const [baseJson, png, historicalManifest] = await Promise.all([
      readFileAt(historic, paths.json),
      readFileAt(historic, paths.png),
      readFileAt(historic, paths.manifest),
    ]);
    assert.equal(
      JSON.parse(historicalManifest.toString()).map_revision,
      currentManifest.map_revision,
      "Need maintenance-only divergence.",
    );
    assert.ok(
      (
        await github.rest.repos.compareCommits({
          owner,
          repo,
          base: historic,
          head: main,
        })
      ).data.ahead_by > 0,
    );
    const id = randomUUID(),
      actor = randomUUID(),
      json = Buffer.concat([baseJson, Buffer.from("\n")]);
    const pair = await validatePair(json, png);
    const manifest = {
      ...currentManifest,
      editor: pair.document.format,
      map_revision: pair.revision,
      base_map_revision: currentManifest.map_revision,
      base_commit_sha: historic,
      operation_id: id,
      contributor_display_name: "Maintenance acceptance",
      summary: "Disposable maintenance catch-up acceptance",
      selected_issue_numbers: [],
      created_at: new Date().toISOString(),
      files: {
        json: { path: paths.json, bytes: json.length, sha256: pair.jsonHash },
        png: {
          path: paths.png,
          bytes: png.length,
          sha256: pair.pngHash,
          width: pair.image.width,
          height: pair.image.height,
        },
      },
    };
    const rawManifest = Buffer.from(JSON.stringify(manifest, null, 4) + "\n");
    const blobs = await Promise.all(
      [json, png, rawManifest].map((data) =>
        github.rest.git.createBlob({
          owner,
          repo,
          content: data.toString("base64"),
          encoding: "base64",
        }),
      ),
    );
    const base = await github.rest.git.getCommit({
      owner,
      repo,
      commit_sha: historic,
    });
    const tree = await github.rest.git.createTree({
      owner,
      repo,
      base_tree: base.data.tree.sha,
      tree: Object.values(paths).map((path, i) => ({
        path,
        mode: "100644",
        type: "blob",
        sha: blobs[i].data.sha,
      })),
    });
    const commit = await github.rest.git.createCommit({
      owner,
      repo,
      tree: tree.data.sha,
      parents: [historic],
      message: "Disposable map maintenance acceptance",
    });
    branch = `metro-update/${id}`;
    await github.rest.git.createRef({
      owner,
      repo,
      ref: `refs/heads/${branch}`,
      sha: commit.data.sha,
    });
    const pr = await github.rest.pulls.create({
      owner,
      repo,
      head: branch,
      base: "main",
      draft: true,
      title: "TEST ONLY: automatic maintenance catch-up",
      body: `Disposable acceptance. Never merge.\n\n<!-- metro-operation:${id} -->`,
    });
    prNumber = pr.data.number;
    report.prUrl = pr.data.html_url;
    report.originalHead = commit.data.sha;
    report.baseCommit = main;
    console.log(
      `Created disposable draft ${pr.data.html_url}; no main update or merge will be performed.`,
    );
    await query('INSERT INTO "user"(id,name,email) VALUES($1,$2,$3)', [
      actor,
      "Maintenance acceptance",
      `${actor}@example.invalid`,
    ]);
    await query(
      "INSERT INTO metro_profiles(user_id,role,active) VALUES($1,'collaborator',true)",
      [actor],
    );
    await query(
      `INSERT INTO metro_operations(id,kind,scope,idempotency_key,request_digest,actor_id,status,payload,checkpoint,result)
    VALUES($1::uuid,'update','live-maintenance',$1::text,'fixture',$2,'awaiting_review',$3,$4,$5)`,
      [
        id,
        actor,
        JSON.stringify({
          baseCommit: historic,
          baseMapRevision: currentManifest.map_revision,
        }),
        JSON.stringify({
          repository: `${owner}/${repo}`,
          baseBranch: "main",
          commitSha: commit.data.sha,
          mapRevision: pair.revision,
        }),
        JSON.stringify({ prNumber, prUrl: pr.data.html_url }),
      ],
    );
    const operation = await acceptOperation({
      kind: "refresh-update",
      scope: `refresh-update:${id}`,
      key: randomUUID(),
      actorId: actor,
      payload: {
        updateId: id,
        headSha: commit.data.sha,
        baseCommit: main,
        baseMapRevision: currentManifest.map_revision,
      },
      authorize: async () => {},
    });
    const leased = await leaseOperation(operation.id);
    assert.ok(leased);
    const result = await processMaintenanceSync(leased.op, leased.token);
    await finishOperation(operation.id, leased.token, "succeeded", result);
    assert.ok("headSha" in result);
    const newHead = String(result.headSha);
    assert.notEqual(newHead, commit.data.sha);
    const originalBytes = [json, png, rawManifest];
    for (const [index, path] of Object.values(paths).entries())
      assert.deepEqual(await readFileAt(newHead, path), originalBytes[index]);
    const comparison = await github.rest.repos.compareCommits({
      owner,
      repo,
      base: main,
      head: newHead,
    });
    assert.equal(comparison.data.behind_by, 0);
    assert.ok(
      comparison.data.files?.every((file) =>
        Object.values(paths).includes(file.filename as typeof paths.json),
      ),
    );
    report.updatedHead = newHead;
    report.exactMapBytesPreserved = true;
    report.noWorkflowOrAdministrationGrant = true;
    report.nonMapFilesMatchMain = true;
    console.log(
      `PASS: runtime App caught up the draft to main; original JSON/PNG/manifest bytes preserved. Waiting for validate-map on ${newHead}.`,
    );
    let passed = false;
    for (let attempt = 0; attempt < 24; attempt++) {
      const checks = await github.rest.checks.listForRef({
        owner,
        repo,
        ref: newHead,
        check_name: "validate-map",
        filter: "latest",
      });
      const check = checks.data.check_runs.find(
        (check) => check.app?.slug === "github-actions",
      );
      if (check?.status === "completed") {
        report.validationUrl = check.html_url;
        assert.equal(
          check.conclusion,
          "success",
          "Fresh trusted validation must pass.",
        );
        passed = true;
        break;
      }
      if (attempt % 4 === 0)
        console.log(`Waiting for fresh trusted validation (${attempt * 5}s).`);
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
    assert.equal(
      passed,
      true,
      "Fresh validation did not complete within two minutes.",
    );
    report.mainUnchanged = (await currentHead()) === main;
    assert.equal(report.mainUnchanged, true);
    report.pass = true;
    console.log(
      "PASS: fresh validate-map succeeded; main was unchanged; PR remains unmerged.",
    );
  } finally {
    report.mainUnchanged =
      !report.baseCommit || (await currentHead()) === report.baseCommit;
    report.operations = (
      await query(
        "SELECT id,kind,status,error_code,checkpoint FROM metro_operations ORDER BY created_at",
      )
    ).rows;
    if (prNumber)
      await github.rest.pulls.update({
        owner,
        repo,
        pull_number: prNumber,
        state: "closed",
      });
    if (branch)
      await github.rest.git.deleteRef({ owner, repo, ref: `heads/${branch}` });
    await writeFile(
      "/tmp/ckocc-maintenance-live.json",
      JSON.stringify(report, null, 2) + "\n",
    );
    await getPool().end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
}
main().catch((error) => {
  console.error("Live maintenance acceptance failed", {
    type: error?.name,
    status: error?.status,
    reason: error?.response?.data?.message ?? error?.code ?? "Runtime failure",
  });
  process.exitCode = 1;
});
