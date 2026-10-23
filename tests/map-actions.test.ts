import assert from "node:assert/strict";
import { before, beforeEach, mock, test } from "node:test";
import sharp from "sharp";
import { validatePair, type MapManifest } from "../src/server/maps/validate";
import type { Operation } from "../src/server/operations/store";
import { PipelineError } from "../src/server/operations/errors";

const sourceId = "00000000-0000-4000-8000-000000000001";
const actionId = "00000000-0000-4000-8000-000000000002";
const oldCommit = "1".repeat(40),
  baseCommit = "2".repeat(40),
  headCommit = "3".repeat(40);
const paths = {
  json: "maps/network.json",
  png: "maps/network.png",
  manifest: "maps/manifest.json",
} as const;
let source: Operation, action: Operation;
let signedIn = true,
  active = true,
  validSession = true,
  role = "admin",
  sessionDate = new Date();
let head = baseCommit,
  merged = false,
  state = "open",
  prHead = headCommit,
  mergeable = true;
let mergeState = "clean",
  draft = false,
  protection = true,
  allowMerge = true;
let checkStatus = "completed",
  checksUnavailable = false;
let checkConclusion = "success",
  checkApp = "github-actions",
  changedPaths: string[];
let cachedPrHead: string | undefined;
let mergeParents: string[] = [],
  checksOnHead = true;
let behind = 0,
  refUpdates = 0;
let refreshMode = "none";
let blobContents: string[] = [];
let commitParents: string[] = [];
let treeBase = "";
let treePaths: string[] = [];
let prBody: string | undefined, prTitle: string | undefined;
let prOverrides: Record<string, unknown> = {};
let closeCalls = 0,
  metadataCalls = 0;
let mergeCalls = 0,
  createCalls = 0,
  publicationCalls = 0,
  timeoutMode = "none",
  branches: Record<string, string>;
let createdPr: {
  body: string;
  head: { sha: string };
  user: { login: string };
  number: number;
  html_url: string;
} | null;
let finished: string[], existingRequest: Operation | null;
let publicationFails = false;
let finishedResult: Record<string, unknown> = {};
let files: Record<string, Record<string, Buffer>>;
let templates: Record<string, Record<string, Buffer>>;
let manifests: Record<string, MapManifest>;

function makeOp(kind: Operation["kind"]): Operation {
  return {
    id: kind === "update" ? sourceId : actionId,
    kind,
    actor_id: "admin",
    scope: "test",
    idempotency_key: "test",
    request_digest: "",
    receipt_digest: null,
    payload: {},
    checkpoint: { repository: "test/map", baseBranch: "main" },
    result: {},
    status: "accepted",
    attempts: 1,
    error_code: null,
    created_at: new Date("2026-10-10T12:00:00Z"),
    updated_at: new Date(),
    next_attempt_at: new Date(),
  };
}
function pr() {
  return {
    number: 42,
    html_url: "https://github.com/test/map/pull/42",
    state,
    merged,
    draft,
    mergeable,
    mergeable_state: mergeState,
    head: {
      sha: cachedPrHead ?? prHead,
      ref: `metro-update/${sourceId}`,
      repo: { full_name: "test/map" },
    },
    base: { sha: head, ref: "main", repo: { full_name: "test/map" } },
    user: { login: "metro[bot]" },
    body: prBody ?? `<!-- metro-operation:${sourceId} -->`,
    title: prTitle ?? "Map update: Map",
    merge_commit_sha: "4".repeat(40),
    ...prOverrides,
  };
}
mock.module("../src/server/auth/config.ts", {
  namedExports: {
    siteOrigin: () => "http://localhost:3000",
    getAuth: () => ({
      api: {
        getSession: async () =>
          signedIn
            ? {
                user: { id: "admin" },
                session: { id: "session", createdAt: sessionDate },
              }
            : null,
      },
    }),
  },
});
mock.module("../src/server/db/index.ts", {
  namedExports: {
    query: async (sql: string, params: unknown[] = []) => {
      if (sql.includes("payload=payload||$3::jsonb")) {
        Object.assign(source.payload, JSON.parse(String(params[2])));
        Object.assign(source.checkpoint, JSON.parse(String(params[3])));
        Object.assign(source.result, JSON.parse(String(params[4])));
        return { rowCount: 1, rows: [{ id: source.id }] };
      }
      if (sql.includes("checkpoint=checkpoint||$3::jsonb")) {
        assert.equal(params[0], source.id);
        if (params[1] !== source.checkpoint.commitSha)
          return { rowCount: 0, rows: [] };
        Object.assign(source.checkpoint, JSON.parse(String(params[2])));
        return { rowCount: 1, rows: [{ id: source.id }] };
      }
      if (sql.includes('SELECT s.id FROM "session"'))
        return { rowCount: validSession ? 1 : 0, rows: [] };
      if (sql.includes("SELECT u.id, u.email, u.name"))
        return {
          rows: [
            {
              id: "admin",
              email: "test@example.invalid",
              name: "Admin",
              role,
              active,
            },
          ],
        };
      if (sql.includes("scope=$1"))
        return { rows: existingRequest ? [existingRequest] : [] };
      return { rowCount: 1, rows: [] };
    },
    transaction: async (fn: (c: unknown) => unknown) =>
      fn({ query: async () => ({ rows: [{ count: 1 }] }) }),
  },
});
const client = {
  rest: {
    repos: {
      get: async () => ({
        data: { default_branch: "main", allow_merge_commit: allowMerge },
      }),
      getBranch: async () => ({ data: { protected: protection } }),
      compareCommits: async () => ({
        data: { status: "ahead", behind_by: behind },
      }),
    },
    checks: {
      listForRef: async ({ ref }: { ref: string }) => {
        if (!checksOnHead && ref === prHead)
          return { data: { check_runs: [] } };
        if (checksUnavailable) throw new Error("Checks unavailable");
        return {
          data: {
            check_runs: [
              {
                name: "validate-map",
                app: { slug: checkApp },
                status: checkStatus,
                id: 77,
                output: { title: "Map validation" },
                conclusion: checkConclusion,
              },
            ],
          },
        };
      },
    },
    pulls: {
      get: async () => ({ data: pr() }),
      update: async (input: {
        state?: string;
        body?: string;
        title?: string;
      }) => {
        if (input.state) closeCalls++;
        else metadataCalls++;
        if (timeoutMode === "before") throw new Error("timeout before write");
        if (input.state) state = input.state;
        if (input.body) prBody = input.body;
        if (input.title) prTitle = input.title;
        if (timeoutMode === "after") throw new Error("timeout after write");
        return { data: pr() };
      },
      listFiles: async () => ({
        data: changedPaths.map((filename) => ({
          filename,
          status: "modified",
        })),
      }),
      list: async () => ({ data: createdPr ? [createdPr] : [] }),
      merge: async (input: { sha: string; merge_method: string }) => {
        mergeCalls++;
        assert.equal(input.sha, headCommit);
        assert.equal(input.merge_method, "merge");
        if (timeoutMode === "denied")
          throw Object.assign(new Error("Branch rules reject merge"), {
            status: 405,
          });
        if (timeoutMode === "before") throw new Error("timeout");
        merged = true;
        if (timeoutMode === "after") throw new Error("timeout");
        return { data: { merged: true, sha: "4".repeat(40) } };
      },
      create: async (input: { body: string }) => {
        createCalls++;
        createdPr = {
          ...input,
          user: { login: "metro[bot]" },
          head: { sha: "5".repeat(40) },
          number: 43,
          html_url: "https://github.com/test/map/pull/43",
        };
        if (timeoutMode === "after") throw new Error("timeout");
        return { data: createdPr };
      },
    },
    git: {
      getCommit: async ({ commit_sha }: { commit_sha: string }) => ({
        data: {
          tree: { sha: `tree-${commit_sha}` },
          parents: mergeParents.map((sha) => ({ sha })),
        },
      }),
      createBlob: async ({ content }: { content: string }) => {
        blobContents.push(content);
        return { data: { sha: "blob" } };
      },
      createTree: async ({
        base_tree,
        tree,
      }: {
        base_tree: string;
        tree: { path: string }[];
      }) => {
        treeBase = base_tree;
        treePaths = tree.map((x) => x.path);
        return { data: { sha: "tree" } };
      },
      createCommit: async ({ parents }: { parents: string[] }) => {
        commitParents = parents;
        return { data: { sha: "5".repeat(40) } };
      },
      updateRef: async ({
        sha,
        force,
        ref,
      }: {
        sha: string;
        force: boolean;
        ref: string;
      }) => {
        refUpdates++;
        assert.equal(force, false);
        assert.equal(ref, `heads/metro-update/${sourceId}`);
        if (refreshMode === "before") throw new Error("timeout before write");
        if (refreshMode === "denied") throw { status: 403 };
        files[sha] = { ...files[prHead] };
        prHead = sha;
        if (refreshMode === "after") throw new Error("timeout after write");
      },
      getRef: async ({ ref }: { ref: string }) => {
        if (action.kind === "refresh-update" || action.kind === "edit-update")
          return { data: { object: { sha: prHead } } };
        if (!branches[ref]) throw { status: 404 };
        return { data: { object: { sha: branches[ref] } } };
      },
      createRef: async ({ ref, sha }: { ref: string; sha: string }) => {
        branches[ref.replace(/^refs\//, "")] = sha;
      },
    },
  },
  paginate: async (
    method: (input: any) => Promise<{ data: unknown }>,
    input: unknown,
  ) => {
    const { data } = await method(input);
    return Array.isArray(data)
      ? data
      : (data as { check_runs: unknown[] }).check_runs;
  },
};
mock.module("../src/server/github/client.ts", {
  namedExports: {
    MAP_PATHS: paths,
    expectedBotLogin: () => "metro[bot]",
    github: async () => client,
    repositoryConfig: () => ({
      owner: "test",
      repo: "map",
      key: "test/map",
      branch: "main",
    }),
    currentHead: async () => head,
    readFileAt: async (commit: string, path: string) => {
      if (!files[commit]?.[path])
        throw new PipelineError("base_revision_not_found", 404);
      return files[commit][path];
    },
  },
});
mock.module("../src/server/storage/staging.ts", {
  namedExports: {
    uploadRecord: async (id: string) => ({
      owner_id: "admin",
      edit_session_id: "edit",
      kind: id,
      status: "ready",
    }),
    readStaged: async (upload: { kind: "json" | "png" }) =>
      files[headCommit][paths[upload.kind]],
  },
});
mock.module("../src/server/operations/store.ts", {
  namedExports: {
    getOperation: async (id: string) => (id === sourceId ? source : action),
    checkpoint: async (_id: string, _token: string, patch: object) =>
      Object.assign(action.checkpoint, patch),
    acceptOperation: async (input: {
      kind: Operation["kind"];
      payload: Record<string, unknown>;
      authorize: () => Promise<void>;
    }) => {
      await input.authorize();
      action = makeOp(input.kind);
      action.payload = input.payload;
      return action;
    },
    operationView: (op: Operation) => ({ id: op.id, status: op.status }),
    leaseOperation: async () => ({ op: action, token: "lease" }),
    finishOperation: async (
      _id: string,
      _token: string,
      status: string,
      result: Record<string, unknown>,
    ) => {
      finishedResult = result;
      finished.push(status);
    },
  },
});
mock.module("../src/server/operations/outbox.ts", {
  namedExports: { launchOperation: async () => {} },
});
mock.module("../src/server/maps/publication.ts", {
  namedExports: {
    synchronizePullRequests: async () => {},
    synchronizePublication: async () => {
      publicationCalls++;
      if (publicationFails) throw new Error("Publication unavailable");
    },
  },
});
let maintenance: typeof import("../src/server/operations/maintenance");
let actions: typeof import("../src/server/operations/map-actions");
let routes: typeof import("../src/server/operations/map-action-handlers");
let processUpdate: typeof import("../src/server/operations/update").processUpdate;
let executeOperation: typeof import("../src/server/operations/worker").executeOperation;
before(async () => {
  const png = await sharp({
    create: { width: 2, height: 2, channels: 3, background: "blue" },
  })
    .png()
    .toBuffer();
  templates = {};
  manifests = {};
  for (const [i, commit] of [oldCommit, baseCommit, headCommit].entries()) {
    const json = Buffer.from(
      JSON.stringify({
        version: 80,
        mapEnabled: false,
        mapStyle: {},
        svgViewBoxZoom: 100,
        svgViewBoxMin: { x: 0, y: 0 },
        images: [],
        graph: { options: {}, attributes: {}, nodes: [], edges: [] },
        name: `map ${i}`,
      }),
    );
    const pair = await validatePair(json, png);
    const manifest: MapManifest = {
      schema_version: 1,
      editor: pair.document.format,
      map_revision: pair.revision,
      base_commit_sha: i === 2 ? baseCommit : null,
      base_map_revision: i === 2 ? manifests[baseCommit].map_revision : null,
      operation_id: i === 2 ? sourceId : `bootstrap-${i}`,
      contributor_display_name: "Admin",
      summary: "Map",
      selected_issue_numbers: [],
      created_at: new Date().toISOString(),
      files: {
        json: { path: paths.json, sha256: pair.jsonHash, bytes: json.length },
        png: {
          path: paths.png,
          sha256: pair.pngHash,
          bytes: png.length,
          width: 2,
          height: 2,
        },
      },
    };
    templates[commit] = {
      [paths.json]: json,
      [paths.png]: png,
      [paths.manifest]: Buffer.from(JSON.stringify(manifest)),
    };
    manifests[commit] = manifest;
  }
  maintenance = await import("../src/server/operations/maintenance");
  actions = await import("../src/server/operations/map-actions");
  routes = await import("../src/server/operations/map-action-handlers");
  ({ processUpdate } = await import("../src/server/operations/update"));
  ({ executeOperation } = await import("../src/server/operations/worker"));
});
beforeEach(() => {
  process.env.ABUSE_HASH_SECRET = "map-actions-test-secret-32-characters";
  process.env.WEBSITE_MERGES_ENABLED = "true";
  signedIn = active = validSession = protection = allowMerge = mergeable = true;
  role = "admin";
  prBody = prTitle = undefined;
  prOverrides = {};
  closeCalls = metadataCalls = 0;
  sessionDate = new Date();
  head = baseCommit;
  cachedPrHead = undefined;
  mergeParents = [];
  checksOnHead = true;
  behind = refUpdates = 0;
  refreshMode = "none";
  blobContents = [];
  commitParents = [];
  treeBase = "";
  treePaths = [];
  merged = draft = false;
  state = "open";
  prHead = headCommit;
  mergeState = "clean";
  checkConclusion = "success";
  checkStatus = "completed";
  checksUnavailable = false;
  checkApp = "github-actions";
  changedPaths = Object.values(paths);
  mergeCalls = createCalls = publicationCalls = 0;
  timeoutMode = "none";
  branches = {};
  createdPr = null;
  finished = [];
  finishedResult = {};
  publicationFails = false;
  existingRequest = null;
  files = Object.fromEntries(
    Object.entries(templates).map(([key, value]) => [key, { ...value }]),
  );
  source = makeOp("update");
  source.payload = {
    baseCommit,
    baseMapRevision: manifests[baseCommit].map_revision,
  };
  source.result = { prNumber: 42 };
  source.checkpoint.commitSha = headCommit;
  source.checkpoint.mapRevision = manifests[headCommit].map_revision;
  action = makeOp("merge");
  action.payload = { updateId: sourceId, headSha: headCommit, baseCommit };
});
const context = { params: Promise.resolve({ id: sourceId }) };
function request(
  kind = "merge",
  input: object = { headSha: headCommit, baseCommit },
  origin = "http://localhost:3000",
) {
  return new Request(
    `http://localhost:3000/api/admin/updates/${sourceId}/${kind}`,
    {
      method: "POST",
      headers: {
        Origin: origin,
        "Content-Type": "application/json",
        "Idempotency-Key": "00000000-0000-4000-8000-000000000003",
      },
      body: JSON.stringify(input),
    },
  );
}
test("merge confirmation enqueues a durable operation and worker pins SHA then publishes", async () => {
  assert.equal((await routes.postMerge(request(), context)).status, 202);
  await executeOperation(actionId);
  assert.equal(mergeCalls, 1);
  assert.equal(publicationCalls, 1);
  assert.deepEqual(finished, ["succeeded"]);
});
test("ruleset blocked state permits checked PRs while GitHub enforces merge access", async () => {
  mergeState = "blocked";
  assert.equal((await actions.reviewMapUpdate(sourceId)).canMerge, true);
  await executeOperation(actionId);
  assert.equal(mergeCalls, 1);
  assert.deepEqual(finished, ["succeeded"]);
});
test("ruleset blocked state still rejects failed checks and stale branches", async () => {
  mergeState = "blocked";
  checkConclusion = "failure";
  assert.equal((await actions.reviewMapUpdate(sourceId)).canMerge, false);
  await executeOperation(actionId);
  assert.equal(mergeCalls, 0);
  checkConclusion = "success";
  mergeState = "behind";
  assert.equal((await actions.reviewMapUpdate(sourceId)).canMerge, false);
});
test("GitHub rejection of a checked blocked PR records a safe failure", async () => {
  mergeState = "blocked";
  timeoutMode = "denied";
  await assert.rejects(actions.processMerge(action, "lease"), {
    code: "merge_blocked",
  });
  assert.equal(merged, false);
  assert.equal(action.checkpoint.mergeIntent, false);
});
test("routes reject anonymous, collaborators, expired, disabled and old sessions", async () => {
  for (const scenario of [
    "anonymous",
    "collaborator",
    "expired",
    "disabled",
    "old",
  ]) {
    signedIn = scenario !== "anonymous";
    role = scenario === "collaborator" ? "collaborator" : "admin";
    validSession = scenario !== "expired";
    active = scenario !== "disabled";
    sessionDate = new Date(Date.now() - (scenario === "old" ? 16 * 60_000 : 0));
    assert.equal(
      (await routes.postMerge(request(), context)).status,
      scenario === "collaborator" ? 403 : 401,
    );
    assert.equal(
      (await routes.postRollback(request("rollback", { baseCommit }), context))
        .status,
      scenario === "collaborator" ? 403 : 401,
    );
  }
  assert.equal(mergeCalls, 0);
  assert.equal(createCalls, 0);
});
test("same-origin and payload checks reject forged requests", async () => {
  assert.equal(
    (
      await routes.postMerge(
        request("merge", {}, "https://other.invalid"),
        context,
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await routes.postMerge(
        request("merge", { headSha: "bad", baseCommit }),
        context,
      )
    ).status,
    422,
  );
  assert.equal(
    (
      await routes.postMerge(
        request("merge", { headSha: headCommit, baseCommit, repo: "other" }),
        context,
      )
    ).status,
    422,
  );
});
test("read review also rejects non-admin accounts", async () => {
  role = "collaborator";
  assert.equal(
    (await routes.getReview(new Request("http://localhost:3000"), context))
      .status,
    403,
  );
});
test("workers recheck demoted and disabled administrators before writes", async () => {
  role = "collaborator";
  await assert.rejects(actions.processMerge(action, "lease"), {
    code: "forbidden",
  });
  action.kind = "rollback";
  await assert.rejects(processUpdate(action, "lease"), { code: "forbidden" });
  role = "admin";
  active = false;
  await assert.rejects(actions.processMerge(action, "lease"), {
    code: "unauthorized",
  });
  assert.equal(mergeCalls, 0);
  assert.equal(createCalls, 0);
});
test("merge blocks failed, missing or untrusted checks, stale bases and repository rules", async () => {
  checkConclusion = "failure";
  assert.equal(
    (await actions.reviewMapUpdate(sourceId)).blockedReason,
    "map_checks_pending",
  );
  checkConclusion = "success";
  checkStatus = "completed";
  checksUnavailable = false;
  checkApp = "other";
  assert.equal((await actions.reviewMapUpdate(sourceId)).canMerge, false);
  checkApp = "github-actions";
  protection = false;
  assert.equal(
    (await actions.reviewMapUpdate(sourceId)).blockedReason,
    "merge_not_configured",
  );
  protection = true;
  mergeState = "dirty";
  assert.equal(
    (await actions.reviewMapUpdate(sourceId)).blockedReason,
    "merge_conflicts",
  );
  mergeState = "clean";
  head = oldCommit;
  assert.equal(
    (await actions.reviewMapUpdate(sourceId)).blockedReason,
    "stale_base_revision",
  );
});
test("unconfigured, closed and draft PRs cannot merge", async () => {
  process.env.WEBSITE_MERGES_ENABLED = "false";
  assert.equal(
    (await actions.reviewMapUpdate(sourceId)).blockedReason,
    "merge_not_configured",
  );
  process.env.WEBSITE_MERGES_ENABLED = "true";
  draft = true;
  assert.equal(
    (await actions.reviewMapUpdate(sourceId)).blockedReason,
    "pr_draft",
  );
  state = "closed";
  assert.equal(
    (await actions.reviewMapUpdate(sourceId)).blockedReason,
    "pr_closed",
  );
});
test("changed PR heads and unexpected files are rejected before merging", async () => {
  prHead = oldCommit;
  await assert.rejects(actions.processMerge(action, "lease"), {
    code: "pr_identity_changed",
  });
  prHead = headCommit;
  changedPaths.push("README.md");
  await assert.rejects(actions.processMerge(action, "lease"), {
    code: "pr_identity_changed",
  });
  assert.equal(mergeCalls, 0);
});
test("a competing merge after confirmation requires reconciliation", async () => {
  head = oldCommit;
  await executeOperation(actionId);
  assert.deepEqual(finished, ["needs_reconciliation"]);
  assert.equal(mergeCalls, 0);
});
test("merge timeouts reconcile success without a second write", async () => {
  timeoutMode = "after";
  assert.equal(
    (await actions.processMerge(action, "lease")).mergeCommitSha,
    "4".repeat(40),
  );
  await actions.processMerge(action, "lease");
  assert.equal(mergeCalls, 1);
});
test("uncertain merge outcomes remain lookup-only on retries", async () => {
  timeoutMode = "before";
  await assert.rejects(actions.processMerge(action, "lease"), {
    code: "outcome_unknown",
  });
  await assert.rejects(actions.processMerge(action, "lease"), {
    code: "outcome_unknown",
  });
  assert.equal(mergeCalls, 1);
});
test("rollback restores verified historical files with a fresh manifest and no issue directives", async () => {
  merged = true;
  source.payload.baseCommit = oldCommit;
  source.payload.baseMapRevision = manifests[oldCommit].map_revision;
  const response = await routes.postRollback(
    request("rollback", { baseCommit }),
    context,
  );
  assert.equal(response.status, 202);
  assert.equal(action.kind, "rollback");
  await processUpdate(action, "lease");
  const manifest = action.checkpoint.manifest as MapManifest;
  assert.equal(manifest.map_revision, manifests[oldCommit].map_revision);
  assert.equal(manifest.base_map_revision, manifests[baseCommit].map_revision);
  assert.equal(manifest.base_commit_sha, baseCommit);
  assert.equal(manifest.operation_id, actionId);
  assert.deepEqual(manifest.selected_issue_numbers, []);
  assert.equal(manifest.contributor_display_name, "Admin");
  assert.doesNotMatch(createdPr!.body, /Closes #/);
  assert.equal(createCalls, 1);
});
test("rollback detects missing history, no-op restores and changed bases", async () => {
  merged = true;
  assert.equal(
    (await actions.reviewMapUpdate(sourceId)).blockedReason,
    "unchanged_map",
  );
  source.payload.baseCommit = oldCommit;
  source.payload.baseMapRevision = manifests[oldCommit].map_revision;
  await assert.rejects(actions.rollbackInput(sourceId, headCommit), {
    code: "stale_base_revision",
  });
  delete files[oldCommit];
  await assert.rejects(actions.rollbackInput(sourceId, baseCommit), {
    code: "base_revision_not_found",
  });
});
test("rollback creation timeout recovers its PR instead of creating a duplicate", async () => {
  merged = true;
  source.payload.baseCommit = oldCommit;
  source.payload.baseMapRevision = manifests[oldCommit].map_revision;
  action.kind = "rollback";
  action.payload = await actions.rollbackInput(sourceId, baseCommit);
  timeoutMode = "after";
  await assert.rejects(processUpdate(action, "lease"));
  const recovered = await processUpdate(action, "lease");
  assert.equal(recovered.prNumber, 43);
  assert.equal(createCalls, 1);
});
test("same browser key returns the accepted receipt after state changes and rejects changed parameters", async () => {
  existingRequest = action;
  merged = true;
  const response = await routes.postMerge(request(), context);
  assert.equal(response.status, 202);
  assert.equal((await response.json()).operation.id, actionId);
  assert.equal(
    (
      await routes.postMerge(
        request("merge", { headSha: oldCommit, baseCommit }),
        context,
      )
    ).status,
    409,
  );
});

test("publication failure preserves successful merge evidence and retry never merges twice", async () => {
  publicationFails = true;
  const result = await executeOperation(actionId);
  assert.equal(result.retry, true);
  assert.deepEqual(finished, ["failed"]);
  assert.equal(finishedResult.mergeCommitSha, "4".repeat(40));
  assert.equal(finishedResult.publicationPending, true);
  publicationFails = false;
  await executeOperation(actionId);
  assert.equal(mergeCalls, 1);
  assert.deepEqual(finished, ["failed", "succeeded"]);
});

test("review exposes current check results even when another merge rule blocks", async () => {
  for (const conclusion of ["success", "failure", "cancelled", "skipped"]) {
    checkConclusion = conclusion;
    const review = await actions.reviewMapUpdate(sourceId);
    assert.equal(review.validation.state, conclusion);
    assert.equal(review.canMerge, conclusion === "success");
    assert.equal(review.validation.runs[0].title, "Map validation");
  }
  checkStatus = "in_progress";
  mergeState = "unstable";
  const running = await actions.reviewMapUpdate(sourceId);
  assert.equal(running.validation.state, "running");
  assert.equal(running.canMerge, false);
  checkStatus = "queued";
  assert.equal(
    (await actions.reviewMapUpdate(sourceId)).validation.state,
    "pending",
  );
});
test("untrusted or unavailable checks never appear as passed", async () => {
  checkApp = "other";
  let review = await actions.reviewMapUpdate(sourceId);
  assert.equal(review.validation.state, "pending");
  assert.deepEqual(review.validation.runs, []);
  checksUnavailable = true;
  review = await actions.reviewMapUpdate(sourceId);
  assert.equal(review.validation.state, "unavailable");
  assert.equal(review.canMerge, false);
});

function maintenanceFixture() {
  source.status = "awaiting_review";
  files[oldCommit] = { ...files[baseCommit] };
  source.payload.baseCommit = oldCommit;
  const manifest = JSON.parse(files[headCommit][paths.manifest].toString());
  manifest.base_commit_sha = oldCommit;
  files[headCommit][paths.manifest] = Buffer.from(
    JSON.stringify(manifest, null, 4) + "\n",
  );
  action = makeOp("refresh-update");
  action.payload = {
    updateId: sourceId,
    headSha: headCommit,
    baseCommit,
    baseMapRevision: source.payload.baseMapRevision,
  };
  behind = 1;
}
test("maintenance catch-up preserves all original map bytes and edit base on current approved tree", async () => {
  maintenanceFixture();
  const original = { ...files[headCommit] };
  await maintenance.processMaintenanceSync(action, "lease");
  assert.equal(refUpdates, 1);
  assert.deepEqual(commitParents, [headCommit, baseCommit]);
  assert.equal(treeBase, `tree-${baseCommit}`);
  assert.deepEqual(treePaths, Object.values(paths));
  assert.deepEqual(
    blobContents.map((s) => Buffer.from(s, "base64")),
    Object.values(original),
  );
  assert.equal(source.checkpoint.originalCommitSha, headCommit);
  assert.equal(source.checkpoint.commitSha, "5".repeat(40));
  assert.equal(source.payload.baseCommit, oldCommit);
  assert.equal(source.checkpoint.maintenanceBaseCommit, baseCommit);
  assert.equal(mergeCalls, 0);
  await maintenance.processMaintenanceSync(action, "lease");
  assert.equal(refUpdates, 1);
});
test("maintenance refuses changed maps, unexpected files, and disabled authors before any ref write", async () => {
  maintenanceFixture();
  action.payload.baseMapRevision = "sha256:changed";
  await assert.rejects(maintenance.processMaintenanceSync(action, "lease"), {
    code: "pr_identity_changed",
  });
  action.payload.baseMapRevision = source.payload.baseMapRevision;
  source.payload.baseMapRevision = action.payload.baseMapRevision =
    manifests[oldCommit].map_revision;
  await assert.rejects(maintenance.processMaintenanceSync(action, "lease"), {
    code: "stale_base_revision",
  });
  source.payload.baseMapRevision = action.payload.baseMapRevision =
    manifests[baseCommit].map_revision;
  changedPaths.push("scripts/evil.py");
  await assert.rejects(maintenance.processMaintenanceSync(action, "lease"), {
    code: "pr_identity_changed",
  });
  changedPaths = Object.values(paths);
  active = false;
  await assert.rejects(maintenance.processMaintenanceSync(action, "lease"), {
    code: "unauthorized",
  });
  assert.equal(refUpdates, 0);
});
test("maintenance reconciles a lost successful ref response without repeating the write", async () => {
  maintenanceFixture();
  refreshMode = "after";
  await maintenance.processMaintenanceSync(action, "lease");
  await maintenance.processMaintenanceSync(action, "lease");
  assert.equal(refUpdates, 1);
  assert.equal(source.checkpoint.commitSha, "5".repeat(40));
});
test("uncertain maintenance writes stay unknown until the planned head is observed", async () => {
  maintenanceFixture();
  refreshMode = "before";
  await assert.rejects(maintenance.processMaintenanceSync(action, "lease"), {
    code: "outcome_unknown",
  });
  refreshMode = "none";
  await assert.rejects(maintenance.processMaintenanceSync(action, "lease"), {
    code: "outcome_unknown",
  });
  assert.equal(refUpdates, 1);
  prHead = String(action.checkpoint.refreshCommit);
  await maintenance.processMaintenanceSync(action, "lease");
  assert.equal(refUpdates, 1);
});
test("maintenance skips superseded targets and treats explicit permission rejection as a safe failure", async () => {
  maintenanceFixture();
  action.payload.baseCommit = oldCommit;
  assert.equal(
    "skipped" in (await maintenance.processMaintenanceSync(action, "lease")),
    true,
  );
  assert.equal(refUpdates, 0);
  action.payload.baseCommit = baseCommit;
  refreshMode = "denied";
  await assert.rejects(maintenance.processMaintenanceSync(action, "lease"), {
    code: "maintenance_sync_failed",
  });
  assert.equal(action.checkpoint.refreshIntent, false);
  assert.equal(source.checkpoint.commitSha, headCommit);
});
test("behind PRs queue maintenance automatically and keep confirmation disabled", async () => {
  maintenanceFixture();
  assert.equal(
    (await actions.reviewMapUpdate(sourceId)).blockedReason,
    "maintenance_sync_required",
  );
  const response = await routes.getReview(
    new Request("http://localhost/api/admin/updates/" + sourceId),
    context,
  );
  assert.equal(response.status, 200);
  const { review } = await response.json();
  assert.equal(review.blockedReason, "maintenance_sync_pending");
  assert.equal(review.canMerge, false);
  assert.equal(refUpdates, 0);
});

test("cached test-merge checks cannot approve an updated PR head", async () => {
  checksOnHead = false;
  mergeParents = [oldCommit, baseCommit];
  assert.equal((await actions.reviewMapUpdate(sourceId)).canMerge, false);
  mergeParents = [headCommit, baseCommit];
  assert.equal((await actions.reviewMapUpdate(sourceId)).canMerge, true);
});

test("temporary PR-read caching after catch-up is a pending state, not permission to use old checks", async () => {
  maintenanceFixture();
  await maintenance.processMaintenanceSync(action, "lease");
  cachedPrHead = headCommit;
  await assert.rejects(actions.reviewMapUpdate(sourceId), {
    code: "maintenance_sync_pending",
  });
  await maintenance.processMaintenanceSync(action, "lease");
  assert.equal(refUpdates, 1);
});

test("new map PRs use current maintenance tree without changing the contributor's edit base", async () => {
  files[oldCommit] = { ...files[baseCommit] };
  action = makeOp("update");
  action.payload = {
    baseCommit: oldCommit,
    baseMapRevision: manifests[baseCommit].map_revision,
    editSessionId: "edit",
    summary: "Map update",
    details: "",
    issueNumbers: [],
    jsonUploadId: "json",
    pngUploadId: "png",
  };
  await processUpdate(action, "lease");
  assert.deepEqual(commitParents, [baseCommit]);
  assert.equal(treeBase, `tree-${baseCommit}`);
  const recorded = action.checkpoint.manifest as MapManifest;
  assert.equal(recorded.base_commit_sha, oldCommit);
  assert.equal(recorded.base_map_revision, manifests[baseCommit].map_revision);
  assert.equal(action.checkpoint.prParentCommit, baseCommit);
});

function editingAction() {
  source.status = "awaiting_review";
  source.actor_id = "other-contributor";
  source.checkpoint.amendEditSessionId = "edit";
  action = makeOp("edit-update");
  action.payload = {
    ...source.payload,
    updateId: sourceId,
    headSha: headCommit,
    editSessionId: "edit",
    jsonUploadId: "json",
    pngUploadId: "png",
    summary: "Corrected summary",
    details: "Admin changes",
    issueNumbers: [],
  };
}
test("admin edits another contributor's existing PR with an atomic map commit and refreshed metadata", async () => {
  editingAction();
  await executeOperation(actionId);
  assert.deepEqual(finished, ["succeeded"]);
  assert.equal(refUpdates, 1);
  assert.equal(createCalls, 0);
  assert.equal(metadataCalls, 1);
  assert.equal(mergeCalls, 0);
  assert.deepEqual(commitParents, [headCommit]);
  assert.deepEqual(treePaths, Object.values(paths));
  assert.equal(
    Buffer.from(blobContents[0], "base64").equals(
      files[headCommit][paths.json],
    ),
    true,
  );
  assert.equal(
    Buffer.from(blobContents[1], "base64").equals(files[headCommit][paths.png]),
    true,
  );
  assert.equal(source.actor_id, "other-contributor");
  assert.equal(source.result.prNumber, 42);
  assert.equal(source.payload.summary, "Corrected summary");
  assert.equal(source.checkpoint.commitSha, "5".repeat(40));
  const manifest = JSON.parse(
    Buffer.from(blobContents[2], "base64").toString(),
  );
  assert.equal(manifest.operation_id, sourceId);
  assert.equal(manifest.base_commit_sha, baseCommit);
  assert.match(prBody!, /Admin changes/);
});
for (const mode of ["before", "after"] as const) {
  test(`edit reconciles ref timeout ${mode} write without a second branch update`, async () => {
    editingAction();
    refreshMode = mode;
    await executeOperation(actionId);
    assert.deepEqual(finished, [
      mode === "after" ? "succeeded" : "outcome_unknown",
    ]);
    await executeOperation(actionId);
    assert.equal(refUpdates, 1);
    assert.equal(metadataCalls, mode === "after" ? 1 : 0);
  });
  test(`edit reconciles metadata timeout ${mode} write without repeating it`, async () => {
    editingAction();
    timeoutMode = mode;
    await executeOperation(actionId);
    assert.deepEqual(finished, [
      mode === "after" ? "succeeded" : "outcome_unknown",
    ]);
    await executeOperation(actionId);
    assert.equal(metadataCalls, 1);
    assert.equal(refUpdates, 1);
  });
  test(`close reconciles timeout ${mode} write without a second close`, async () => {
    action = makeOp("close-update");
    action.payload = { updateId: sourceId };
    prHead = "9".repeat(40);
    prBody = "Edited externally without the operation marker";
    timeoutMode = mode;
    await executeOperation(actionId);
    assert.deepEqual(finished, [
      mode === "after" ? "succeeded" : "outcome_unknown",
    ]);
    await executeOperation(actionId);
    assert.equal(closeCalls, 1);
    assert.equal(mergeCalls, 0);
  });
}
test("queued edit and close recheck administrator role and active account", async () => {
  for (const kind of ["edit-update", "close-update"] as const) {
    editingAction();
    action.kind = kind;
    role = "collaborator";
    await executeOperation(actionId);
    role = "admin";
    active = false;
    await executeOperation(actionId);
    active = true;
  }
  assert.equal(refUpdates + closeCalls + metadataCalls, 0);
  assert.deepEqual(finished, ["failed", "failed", "failed", "failed"]);
});
test("edit rejects changed PR head and stale map base before writing", async () => {
  editingAction();
  prHead = "9".repeat(40);
  await executeOperation(actionId);
  assert.deepEqual(finished, ["failed"]);
  prHead = headCommit;
  head = oldCommit;
  await executeOperation(actionId);
  assert.deepEqual(finished, ["failed", "needs_reconciliation"]);
  assert.equal(refUpdates + metadataCalls, 0);
});
test("close HTTP route enforces admin, fresh authentication and same origin", async () => {
  const { POST } =
    await import("../src/app/api/admin/updates/[id]/close/route");
  role = "collaborator";
  assert.equal((await POST(request("close", {}), context)).status, 403);
  role = "admin";
  sessionDate = new Date(Date.now() - 16 * 60_000);
  assert.equal((await POST(request("close", {}), context)).status, 401);
  sessionDate = new Date();
  assert.equal(
    (await POST(request("close", {}, "https://other.invalid"), context)).status,
    403,
  );
  assert.equal((await POST(request("close", {}), context)).status, 202);
  assert.equal(action.kind, "close-update");
  assert.equal(closeCalls, 0);
});

test("close accepts changed PR content and failed validation while merge/edit identity checks remain strict", async () => {
  const { POST } =
    await import("../src/app/api/admin/updates/[id]/close/route");
  prHead = "9".repeat(40);
  checkConclusion = "failure";
  mergeable = false;
  draft = true;
  head = oldCommit;
  changedPaths = ["unexpected.txt"];
  files[prHead] = { [paths.json]: Buffer.from("invalid JSON") };
  await assert.rejects(actions.websitePullRequest(sourceId), {
    code: "pr_identity_changed",
  });
  assert.equal((await POST(request("close", {}), context)).status, 202);
  // Mutable metadata can change again between acceptance and execution.
  prBody = "Edited externally without the operation marker";
  prOverrides = {
    base: { ref: "different-base", repo: { full_name: "test/map" } },
    head: { sha: "8".repeat(40), ref: "different-branch", repo: null },
  };
  await executeOperation(actionId);
  assert.deepEqual(finished, ["succeeded"]);
  assert.equal(closeCalls, 1);
  assert.equal(mergeCalls + refUpdates + publicationCalls, 0);
  assert.equal(state, "closed");
  await assert.rejects(actions.websitePullRequest(sourceId), {
    code: "pr_identity_changed",
  });
});
for (const [name, override] of [
  ["repository", { base: { ref: "main", repo: { full_name: "other/repo" } } }],
  ["creator", { user: { login: "someone-else" } }],
  ["number", { number: 99 }],
] as const) {
  test(`close still rejects a mismatched PR ${name}`, async () => {
    const { POST } =
      await import("../src/app/api/admin/updates/[id]/close/route");
    prOverrides = override;
    assert.equal((await POST(request("close", {}), context)).status, 409);
    action = makeOp("close-update");
    action.payload = { updateId: sourceId };
    await executeOperation(actionId);
    assert.deepEqual(finished, ["failed"]);
    assert.equal(closeCalls, 0);
  });
}
test("close rejects a merged PR and reconciles an already closed changed PR without writing", async () => {
  const { POST } =
    await import("../src/app/api/admin/updates/[id]/close/route");
  merged = true;
  assert.equal((await POST(request("close", {}), context)).status, 409);
  merged = false;
  state = "closed";
  prHead = "9".repeat(40);
  assert.equal((await POST(request("close", {}), context)).status, 202);
  await executeOperation(actionId);
  assert.deepEqual(finished, ["succeeded"]);
  assert.equal(closeCalls, 0);
});
