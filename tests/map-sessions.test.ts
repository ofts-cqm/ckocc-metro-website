import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { before, beforeEach, mock, test } from "node:test";
import { mapRevision } from "../src/server/maps/validate";
import { PipelineError } from "../src/server/operations/errors";
import { errorResponse } from "../src/server/http";

const original = JSON.parse(
  readFileSync("map-data/maps/manifest.json", "utf8"),
);
const changed = structuredClone(original);
changed.files.json.sha256 = "a".repeat(64);
changed.map_revision = mapRevision(
  changed.files.json.sha256,
  changed.files.png.sha256,
);
const restoredCommit = "1".repeat(40);
const updateCommit = "2".repeat(40);
let head: string;
let manifests: Record<string, typeof original>;
let comparisons: string[];
let comparisonStatus: string;
let providerError: unknown;
let historyPages: string[][];
let pages: number[];
let inserted: unknown[][];
let authenticated = true;
const user = {
  id: "player",
  email: "test@example.invalid",
  name: "Player",
  role: "collaborator" as const,
};
mock.module("../src/server/auth/authorize.ts", {
  namedExports: {
    requireUser: async () => {
      if (!authenticated) throw new PipelineError("unauthorized", 401);
      return user;
    },
  },
});
mock.module("../src/server/security/index.ts", {
  namedExports: {
    enforceSameOrigin: () => {},
    enforceRateLimits: async () => {},
  },
});

mock.module("../src/server/db/index.ts", {
  namedExports: {
    getPool: () => {
      throw new Error("Unexpected database pool access");
    },
    transaction: () => {
      throw new Error("Unexpected transaction");
    },
    query: async (sql: string, params: unknown[]) => {
      if (sql.includes("SELECT * FROM metro_operations"))
        return {
          rows: [
            {
              id: "update",
              status: "published",
              payload: {
                summary: "Map update",
                baseMapRevision: original.map_revision,
              },
              result: {},
              checkpoint: { mapRevision: changed.map_revision },
              created_at: new Date(),
              updated_at: new Date(),
              error_code: null,
            },
          ],
        };
      if (sql.includes("INSERT INTO metro_edit_sessions")) {
        inserted.push(params);
        return {
          rows: [
            {
              id: params[0],
              owner_id: params[1],
              base_commit: params[2],
              base_revision: params[3],
              created_at: new Date(),
              expires_at: new Date(),
              status: "draft",
            },
          ],
        };
      }
      return { rows: [] };
    },
  },
});
mock.module("../src/server/github/client.ts", {
  namedExports: {
    MAP_PATHS: { manifest: "maps/manifest.json" },
    repositoryConfig: () => ({ owner: "test", repo: "map" }),
    githubConfigured: () => false,
    currentHead: async () => head,
    readFileAt: async (commit: string) => {
      if (!manifests[commit]) throw { status: 404 };
      return Buffer.from(JSON.stringify(manifests[commit]));
    },
    github: async () => ({
      rest: {
        repos: {
          compareCommits: async ({ base }: { base: string }) => {
            comparisons.push(base);
            if (providerError) throw providerError;
            return { data: { status: comparisonStatus } };
          },
          listCommits: async ({ sha, page }: { sha: string; page: number }) => {
            assert.equal(sha, head);
            pages.push(page);
            if (providerError) throw providerError;
            return {
              data: (historyPages[page - 1] ?? []).map((sha) => ({ sha })),
            };
          },
        },
      },
    }),
  },
});
let resolveMapBase: typeof import("../src/server/maps/sessions").resolveMapBase;
let createEditSession: typeof import("../src/server/maps/sessions").createEditSession;
let assertFresh: typeof import("../src/server/maps/sessions").assertFresh;
let handlers: typeof import("../src/server/operations/handlers");
before(async () => {
  ({ resolveMapBase, createEditSession, assertFresh } =
    await import("../src/server/maps/sessions"));
  handlers = await import("../src/server/operations/handlers");
});
beforeEach(() => {
  authenticated = true;
  head = restoredCommit;
  manifests = { [restoredCommit]: original, [updateCommit]: changed };
  comparisons = [];
  pages = [];
  inserted = [];
  comparisonStatus = "ahead";
  providerError = undefined;
  historyPages = [[restoredCommit, updateCommit]];
});

test("current revision reflects a revert and resolves to the current HEAD", async () => {
  for (const input of [
    undefined,
    original.map_revision,
    original.map_revision.replace("sha256:", "").toUpperCase(),
  ]) {
    const base = await resolveMapBase(input);
    assert.equal(base.commit, restoredCommit);
    assert.equal(base.manifest.map_revision, original.map_revision);
  }
  assert.deepEqual(pages, []);
  assert.deepEqual(comparisons, []);
  await assertFresh(original.map_revision);
  await assert.rejects(assertFresh(changed.map_revision), {
    code: "stale_base_revision",
  });
});

test("historical map SHA-256 resolves approved history after a revert", async () => {
  const base = await resolveMapBase(changed.map_revision);
  assert.equal(base.commit, updateCommit);
  assert.equal(base.manifest.map_revision, changed.map_revision);
  assert.deepEqual(pages, [1]);
});

test("history is paginated and handles map removal commits", async () => {
  historyPages = [Array(100).fill("3".repeat(40)), [updateCommit]];
  assert.equal(
    (await resolveMapBase(changed.map_revision)).commit,
    updateCommit,
  );
  assert.deepEqual(pages, [1, 2]);
});

test("unknown map hashes and individual file hashes return HTTP 404", async () => {
  for (const hash of [
    "f".repeat(64),
    original.files.json.sha256,
    original.files.png.sha256,
  ]) {
    try {
      await resolveMapBase(hash);
      assert.fail("Expected not found");
    } catch (error) {
      const response = errorResponse(error);
      assert.equal(response.status, 404);
      assert.equal(
        (await response.json()).error.code,
        "base_revision_not_found",
      );
    }
  }
});

test("missing Git commits return HTTP 404 instead of HTTP 500", async () => {
  providerError = { status: 404 };
  await assert.rejects(resolveMapBase("f".repeat(40)), (error) => {
    assert.equal(errorResponse(error).status, 404);
    return (error as { code: string }).code === "base_revision_not_found";
  });
});

test("legacy commits must belong to approved history", async () => {
  assert.equal((await resolveMapBase(updateCommit)).commit, updateCommit);
  comparisonStatus = "diverged";
  await assert.rejects(resolveMapBase(updateCommit), {
    code: "unapproved_base_revision",
  });
});

test("malformed hashes fail before provider lookups and provider failures remain distinct", async () => {
  for (const hash of ["nope", "a".repeat(63), `sha256:${"a".repeat(40)}`])
    await assert.rejects(resolveMapBase(hash), { code: "invalid_base_format" });
  assert.deepEqual(pages, []);
  providerError = { status: 403 };
  await assert.rejects(resolveMapBase(changed.map_revision), {
    code: "provider_access_denied",
    status: 503,
  });
});

test("edit session stores the resolved commit and map revision", async () => {
  const session = await createEditSession(
    {
      id: "player",
      email: "test@example.invalid",
      name: "Player",
      role: "collaborator",
    },
    original.map_revision,
  );
  assert.equal(session.baseCommit, restoredCommit);
  assert.equal(session.baseMapRevision, original.map_revision);
  assert.equal(inserted.length, 1);
});

const context = { params: Promise.resolve({}) };

function request(baseCommit: string) {
  return new Request("http://localhost/api/edit-sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ baseCommit }),
  });
}

test("edit-session HTTP route accepts map SHA-256 and reports malformed/missing versions", async () => {
  const accepted = await handlers.postEditSession(
    request(original.map_revision),
    context,
  );
  assert.equal(accepted.status, 201);
  assert.equal((await accepted.json()).editSession.baseCommit, restoredCommit);
  assert.equal(
    (await handlers.postEditSession(request("incorrect"), context)).status,
    422,
  );
  providerError = { status: 404 };
  const missing = await handlers.postEditSession(
    request("f".repeat(40)),
    context,
  );
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).error.code, "base_revision_not_found");
});

test("current map route reads reverted HEAD and history exposes submitted hash", async () => {
  const response = await handlers.getMapHead(
    new Request("http://localhost/api/map/head"),
    context,
  );
  assert.equal(response.status, 200);
  assert.equal((await response.json()).revision, original.map_revision);
  const history = await handlers.getUpdates(
    new Request("http://localhost/api/updates"),
    context,
  );
  assert.equal(history.status, 200);
  assert.equal(
    (await history.json()).updates[0].mapRevision,
    changed.map_revision,
  );
  authenticated = false;
  assert.equal(
    (
      await handlers.getMapHead(
        new Request("http://localhost/api/map/head"),
        context,
      )
    ).status,
    401,
  );
});
