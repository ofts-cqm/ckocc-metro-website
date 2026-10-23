import assert from "node:assert/strict";
import { before, beforeEach, mock, test } from "node:test";
import type { Operation } from "../src/server/operations/store";
let op: Operation & { lease_until: Date | null };
let sessions: Record<string, any>;
let writes: string[];
const user = {
  id: "owner",
  name: "Player",
  email: "p@example.invalid",
  role: "collaborator" as const,
};
mock.module("../src/server/github/client.ts", {
  namedExports: {
    repositoryConfig: () => ({ key: "test/map", branch: "main" }),
    MAP_PATHS: {
      json: "maps/network.json",
      png: "maps/network.png",
      manifest: "maps/manifest.json",
    },
  },
});
mock.module("../src/server/db/index.ts", {
  namedExports: {
    query: async () => ({ rows: [] }),
    transaction: async (run: (client: unknown) => Promise<unknown>) =>
      run({
        query: async (sql: string, params: any[]) => {
          if (sql.startsWith("SELECT id FROM metro_operations"))
            return { rows: [] };
          if (sql.startsWith("SELECT * FROM metro_operations"))
            return { rows: [op] };
          if (sql.startsWith("SELECT * FROM metro_edit_sessions"))
            return { rows: sessions[params[0]] ? [sessions[params[0]]] : [] };
          writes.push(sql);
          if (sql.includes("INSERT INTO metro_edit_sessions")) {
            const session = {
              id: params[0],
              owner_id: params[1],
              base_commit: params[2],
              base_revision: params[3],
              status: "draft",
              expires_at: new Date(Date.now() + 100000),
              created_at: new Date(),
            };
            sessions[session.id] = session;
            return { rows: [session] };
          }
          if (sql.includes("UPDATE metro_operations"))
            Object.assign(op.checkpoint, JSON.parse(params[1]));
          return { rows: [] };
        },
      }),
  },
});
let reviseUpdate: typeof import("../src/server/operations/revise").reviseUpdate;
let canReviseUpdate: typeof import("../src/server/operations/store").canReviseUpdate;
let retryOperation: typeof import("../src/server/operations/store").retryOperation;
before(async () => {
  ({ reviseUpdate } = await import("../src/server/operations/revise"));
  ({ canReviseUpdate, retryOperation } =
    await import("../src/server/operations/store"));
});
beforeEach(() => {
  sessions = {};
  writes = [];
  op = {
    id: "failed-update",
    kind: "update",
    actor_id: user.id,
    status: "failed",
    checkpoint: {
      autoRetry: false,
      repository: "test/map",
      baseBranch: "main",
    },
    result: {},
    lease_until: null,
    payload: {
      editSessionId: "original",
      baseCommit: "1".repeat(40),
      baseMapRevision: `sha256:${"a".repeat(64)}`,
      summary: "Keep summary",
      details: "Keep details",
      issueNumbers: [42],
    },
    scope: "update:owner",
    idempotency_key: "test",
    request_digest: "digest",
    receipt_digest: null,
    attempts: 1,
    error_code: "unsupported_map_format",
    created_at: new Date(),
    updated_at: new Date(),
    next_attempt_at: new Date(),
  };
});
test("recovery keeps text and original base, creates one empty editable session and retires original retry", async () => {
  const result = await reviseUpdate(op.id, user);
  assert.equal(result.summary, "Keep summary");
  assert.equal(result.details, "Keep details");
  assert.deepEqual(result.issueNumbers, [42]);
  assert.equal(result.editSession.baseCommit, op.payload.baseCommit);
  assert.equal(result.editSession.baseMapRevision, op.payload.baseMapRevision);
  assert.equal(result.editSession.status, "draft");
  assert.deepEqual(result.editSession.assets, {});
  assert.equal(op.status, "failed");
  assert.equal(
    (await reviseUpdate(op.id, user)).editSession.id,
    result.editSession.id,
  );
  assert.equal(
    writes.filter((s) => s.includes("INSERT INTO metro_edit_sessions")).length,
    1,
  );
  await assert.rejects(retryOperation(op.id, user.id), {
    code: "operation_not_retryable",
  });
});
test("recovery rejects another owner and every possibly written or active operation", async () => {
  await assert.rejects(
    reviseUpdate(op.id, { ...user, id: "other", role: "collaborator" }),
    { code: "operation_not_found" },
  );
  for (const key of ["commitSha", "branchIntent", "prIntent", "prResult"]) {
    op.checkpoint = { repository: "test/map", baseBranch: "main", [key]: true };
    assert.equal(canReviseUpdate(op), false);
    await assert.rejects(reviseUpdate(op.id, user), {
      code: "operation_not_retryable",
    });
  }
  op.checkpoint = { repository: "test/map", baseBranch: "main" };
  op.status = "outcome_unknown";
  await assert.rejects(reviseUpdate(op.id, user), {
    code: "operation_not_retryable",
  });
  op.status = "failed";
  op.lease_until = new Date(Date.now() + 100000);
  await assert.rejects(reviseUpdate(op.id, user), {
    code: "operation_not_retryable",
  });
  op.lease_until = null;
  op.checkpoint.autoRetry = true;
  await assert.rejects(reviseUpdate(op.id, user), {
    code: "operation_not_retryable",
  });
  assert.deepEqual(writes, []);
});

test("administrator can recover another contributor's failed update into an admin-owned draft", async () => {
  const result = await reviseUpdate(op.id, {
    ...user,
    id: "admin",
    role: "admin",
  });
  assert.equal(sessions[result.editSession.id].owner_id, "admin");
  assert.equal(op.actor_id, "owner");
  assert.equal(result.summary, "Keep summary");
});
