import assert from "node:assert/strict";
import { before, beforeEach, mock, test } from "node:test";
import type { Operation } from "../src/server/operations/store";
import type { SessionUser } from "../src/lib/contracts";
let changedPr = false;
let source: Operation & { lease_until: Date | null };
let pending = false,
  open = false,
  merged = false,
  providerFails = false;
let writes: string[], sessions: Record<string, any>;
const owner: SessionUser = {
  id: "owner",
  name: "Player",
  email: "p@example.invalid",
  role: "collaborator",
};
const admin: SessionUser = { ...owner, id: "admin", role: "admin" };
async function db(sql: string, params: any[] = []) {
  if (sql.startsWith("SELECT * FROM metro_operations"))
    return { rows: [source] };
  if (sql.startsWith("SELECT id FROM metro_operations"))
    return { rows: pending ? [{ id: "pending" }] : [] };
  if (sql.startsWith("SELECT * FROM metro_edit_sessions")) {
    const session = sessions[params[0]];
    return {
      rows:
        session &&
        session.status === "draft" &&
        (!params[1] || session.owner_id === params[1])
          ? [session]
          : [],
    };
  }
  if (sql.startsWith("SELECT * FROM metro_uploads")) return { rows: [] };
  writes.push(sql);
  if (sql.includes("INSERT INTO metro_edit_sessions")) {
    const session = {
      id: params[0],
      owner_id: params[1],
      base_commit: params[2],
      base_revision: params[3],
      status: "draft",
      created_at: new Date(),
      expires_at: new Date(Date.now() + 600000),
    };
    sessions[session.id] = session;
    return { rows: [session] };
  }
  if (sql.startsWith("UPDATE metro_edit_sessions"))
    sessions[params[0]].status = "expired";
  if (sql.startsWith("UPDATE metro_operations"))
    Object.assign(source.checkpoint, JSON.parse(params[1]));
  return { rows: [], rowCount: 1 };
}
mock.module("../src/server/db/index.ts", {
  namedExports: {
    query: db,
    transaction: async (fn: any) => fn({ query: db }),
  },
});
mock.module("../src/server/github/client.ts", {
  namedExports: {
    repositoryConfig: () => ({
      key: "test/map",
      branch: "main",
      owner: "test",
      repo: "map",
    }),
    expectedBotLogin: () => "metro[bot]",
    github: async () => ({
      rest: {
        pulls: {
          list: async () => {
            if (providerFails) throw new Error("offline");
            return { data: [] };
          },
          get: async () => {
            if (providerFails) throw new Error("offline");
            return {
              data: {
                state: open ? "open" : "closed",
                merged,
                number: 42,
                head: {
                  sha: changedPr ? "9".repeat(40) : source.checkpoint.commitSha,
                  ref: `metro-update/${source.id}`,
                  repo: { full_name: "test/map" },
                },
                base: { ref: "main", repo: { full_name: "test/map" } },
                user: { login: "metro[bot]" },
                body: changedPr
                  ? "Changed description"
                  : `<!-- metro-operation:${source.id} -->`,
              },
            };
          },
        },
      },
    }),
  },
});
let manage: typeof import("../src/server/operations/manage-updates");
let store: typeof import("../src/server/operations/store");
before(async () => {
  manage = await import("../src/server/operations/manage-updates");
  store = await import("../src/server/operations/store");
});
beforeEach(() => {
  changedPr = false;
  writes = [];
  sessions = {};
  pending = open = merged = providerFails = false;
  source = {
    id: "source",
    kind: "update",
    actor_id: owner.id,
    status: "failed",
    lease_until: null,
    checkpoint: {
      repository: "test/map",
      baseBranch: "main",
      autoRetry: false,
    },
    result: {},
    payload: {
      summary: "Original",
      details: "Details",
      issueNumbers: [42],
      baseCommit: "1".repeat(40),
      baseMapRevision: `sha256:${"a".repeat(64)}`,
    },
    created_at: new Date(),
    updated_at: new Date(),
    next_attempt_at: new Date(),
    attempts: 1,
    scope: "test",
    idempotency_key: "test",
    request_digest: "test",
    receipt_digest: null,
    error_code: null,
  };
});
test("owner deletes a failed update once, retaining its data and an audit", async () => {
  await manage.deleteUpdate(source.id, owner);
  await manage.deleteUpdate(source.id, owner);
  assert.equal(source.checkpoint.deletedBy, owner.id);
  assert.equal(source.payload.summary, "Original");
  assert.equal(
    writes.filter((s) => s.includes("INSERT INTO metro_pipeline_audit")).length,
    1,
  );
  assert.equal(store.canDeleteUpdate(source), false);
  assert.equal(store.canReviseUpdate(source), false);
  await assert.rejects(store.retryOperation(source.id, owner.id), {
    code: "operation_not_retryable",
  });
});
test("only owner or administrator can delete; administrator can delete another person's update", async () => {
  await assert.rejects(
    manage.deleteUpdate(source.id, { ...owner, id: "other" }),
    { code: "operation_not_found" },
  );
  assert.deepEqual(writes, []);
  await manage.deleteUpdate(source.id, admin);
  assert.equal(source.checkpoint.deletedBy, admin.id);
});
test("deletion refuses active, unknown, retrying, leased and concurrent updates", async () => {
  for (const status of [
    "accepted",
    "creating_pr",
    "awaiting_review",
    "outcome_unknown",
  ] as const) {
    source.status = status;
    await assert.rejects(manage.deleteUpdate(source.id, owner), {
      code: "update_not_deletable",
    });
  }
  source.status = "failed";
  source.checkpoint.autoRetry = true;
  await assert.rejects(manage.deleteUpdate(source.id, owner), {
    code: "update_not_deletable",
  });
  source.checkpoint.autoRetry = false;
  source.lease_until = new Date(Date.now() + 600000);
  await assert.rejects(manage.deleteUpdate(source.id, owner), {
    code: "update_busy",
  });
  source.lease_until = null;
  pending = true;
  await assert.rejects(manage.deleteUpdate(source.id, owner), {
    code: "update_busy",
  });
  assert.deepEqual(writes, []);
});
test("a reopened PR and provider failures prevent deletion even with a stored closed status", async () => {
  source.status = "closed_unmerged";
  source.result.prNumber = 42;
  source.checkpoint.commitSha = "2".repeat(40);
  open = true;
  await assert.rejects(manage.deleteUpdate(source.id, owner), {
    code: "update_has_active_pr",
  });
  open = false;
  providerFails = true;
  await assert.rejects(manage.deleteUpdate(source.id, owner), /offline/);
  assert.deepEqual(writes, []);
  providerFails = false;
  await manage.deleteUpdate(source.id, owner);
  assert.ok(source.checkpoint.deletedAt);
});
test("merged publication history can be removed without changing publication or GitHub", async () => {
  source.status = "published";
  source.result.prNumber = 42;
  source.checkpoint.commitSha = "2".repeat(40);
  merged = true;
  await manage.deleteUpdate(source.id, admin);
  assert.equal(source.status, "published");
  assert.equal(
    writes.some((s) => s.includes("metro_publications")),
    false,
  );
});
test("administrator starts and resumes an editor-owned draft for another contributor's open PR", async () => {
  source.status = "awaiting_review";
  source.result.prNumber = 42;
  source.checkpoint.commitSha = "2".repeat(40);
  open = true;
  await assert.rejects(manage.beginUpdateEdit(source.id, owner), {
    code: "forbidden",
  });
  const draft = await manage.beginUpdateEdit(source.id, admin);
  assert.equal(draft.summary, "Original");
  assert.equal(draft.editSession.baseCommit, source.payload.baseCommit);
  assert.equal(sessions[draft.editSession.id].owner_id, admin.id);
  assert.equal(source.actor_id, owner.id);
  assert.equal(
    (await manage.beginUpdateEdit(source.id, admin)).editSession.id,
    draft.editSession.id,
  );
  await assert.rejects(
    manage.beginUpdateEdit(source.id, { ...admin, id: "other-admin" }),
    { code: "update_busy" },
  );
  source.checkpoint.commitSha = "3".repeat(40);
  const refreshed = await manage.beginUpdateEdit(source.id, admin);
  assert.notEqual(refreshed.editSession.id, draft.editSession.id);
  assert.equal(sessions[draft.editSession.id].status, "expired");
  assert.equal(source.checkpoint.amendHeadSha, "3".repeat(40));
});
test("edit rejects closed PRs, deleted updates and active queued mutations", async () => {
  source.status = "closed_unmerged";
  source.result.prNumber = 42;
  source.checkpoint.commitSha = "2".repeat(40);
  await assert.rejects(manage.beginUpdateEdit(source.id, admin), {
    code: "pr_closed",
  });
  open = true;
  pending = true;
  await assert.rejects(manage.beginUpdateEdit(source.id, admin), {
    code: "update_busy",
  });
  pending = false;
  source.checkpoint.deletedAt = new Date().toISOString();
  await assert.rejects(manage.beginUpdateEdit(source.id, admin), {
    code: "update_not_found",
  });
  assert.deepEqual(writes, []);
});

test("closed PR deletion tolerates changed commits and description but still checks live state", async () => {
  source.status = "closed_unmerged";
  source.result.prNumber = 42;
  source.checkpoint.commitSha = "2".repeat(40);
  changedPr = true;
  open = true;
  await assert.rejects(manage.deleteUpdate(source.id, admin), {
    code: "update_has_active_pr",
  });
  open = false;
  await manage.deleteUpdate(source.id, admin);
  assert.ok(source.checkpoint.deletedAt);
});
