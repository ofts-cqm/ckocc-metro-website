/** Isolated local PostgreSQL recovery acceptance; no provider writes. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { mock } from "node:test";
import { Client } from "pg";

// GitHub reads are mocked; no provider initialization or writes occur.
let mockPrSource = "";
let mockPrHead = "2".repeat(40),
  mockRefHead = mockPrHead;
let providerUnavailable = false,
  wrongCreator = false;
let activeRole = "admin",
  activeAccount = true;
let afterRefRead: (() => Promise<void>) | undefined;
let mockPrState = "open",
  mockPrMerged = false;
let afterPrRead: (() => Promise<void>) | undefined;
let prUnavailable = false;
mock.module("../src/server/github/client.ts", {
  namedExports: {
    repositoryConfig: () => ({
      key: "local/test",
      branch: "main",
      owner: "local",
      repo: "test",
    }),
    expectedBotLogin: () => "metro[bot]",
    github: async () => ({
      rest: {
        git: {
          getRef: async () => {
            if (providerUnavailable) throw new Error("Provider unavailable");
            await afterRefRead?.();
            return { data: { object: { sha: mockRefHead } } };
          },
        },
        pulls: {
          get: async () => {
            if (prUnavailable) throw new Error("Provider unavailable");
            await afterPrRead?.();
            return {
              data: {
                state: mockPrState,
                merged: mockPrMerged,
                number: 42,
                head: {
                  sha: mockPrHead,
                  ref: `metro-update/${mockPrSource}`,
                  repo: { full_name: "local/test" },
                },
                base: { ref: "main", repo: { full_name: "local/test" } },
                user: { login: wrongCreator ? "unrelated[bot]" : "metro[bot]" },
                body: `<!-- metro-operation:${mockPrSource} -->`,
              },
            };
          },
        },
      },
    }),
    githubConfigured: () => false,
    MAP_PATHS: {},
    currentHead: async () => {
      throw new Error("Unexpected provider read");
    },
    readFileAt: async () => {
      throw new Error("Unexpected provider read");
    },
  },
});
mock.module("../src/server/auth/authorize.ts", {
  namedExports: {
    getActiveUser: async (id: string) => {
      if (!activeAccount)
        throw Object.assign(new Error("Inactive"), { code: "unauthorized" });
      return { id, role: activeRole };
    },
    requireUser: async () => ({
      id: "recovery-owner",
      name: "Player",
      email: "p@example.invalid",
      role: "collaborator",
    }),
  },
});
async function main() {
  const connection = process.env.DATABASE_URL;
  if (!connection) throw new Error("A local test database is required.");
  const url = new URL(connection);
  if (
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    !/(test|dev)/i.test(url.pathname)
  )
    throw new Error("Recovery acceptance requires a local test/dev database.");
  const schema = `update_recovery_${randomUUID().replaceAll("-", "")}`;
  const admin = new Client({ connectionString: connection });
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${schema}`);
  url.searchParams.set("options", `-c search_path=${schema}`);
  process.env.DATABASE_URL = url.toString();
  const { query, getPool } = await import("../src/server/db/index");
  try {
    for (const name of ["001_accounts.sql", "002_pipeline.sql"])
      await query(await readFile(`migrations/${name}`, "utf8"));
    const user = {
      id: "recovery-owner",
      name: "Player",
      email: "p@example.invalid",
      role: "collaborator" as const,
    };
    await query('INSERT INTO "user"(id,name,email) VALUES($1,$2,$3)', [
      user.id,
      user.name,
      user.email,
    ]);
    const editId = randomUUID(),
      opId = randomUUID();
    const baseCommit = "1".repeat(40),
      baseMapRevision = `sha256:${"a".repeat(64)}`;
    await query(
      "INSERT INTO metro_edit_sessions(id,owner_id,base_commit,base_revision,expires_at,status) VALUES($1,$2,$3,$4,now()+interval '1 day','submitted')",
      [editId, user.id, baseCommit, baseMapRevision],
    );
    await query(
      `INSERT INTO metro_operations(id,kind,scope,idempotency_key,request_digest,actor_id,status,payload,checkpoint,error_code)
      VALUES($1::uuid,'update','test',$1::text,'test',$2,'failed',$3,'{"autoRetry":false}','unsupported_map_format')`,
      [
        opId,
        user.id,
        JSON.stringify({
          editSessionId: editId,
          baseCommit,
          baseMapRevision,
          summary: "Keep text",
          details: "Keep details",
          issueNumbers: [42],
        }),
      ],
    );
    await query(
      "INSERT INTO metro_outbox(operation_id,state) VALUES($1,'failed')",
      [opId],
    );
    const { reviseUpdate } = await import("../src/server/operations/revise");
    const { retryOperation, leaseOperation } =
      await import("../src/server/operations/store");
    await query(
      'UPDATE metro_operations SET checkpoint=checkpoint||\'{"repository":"local/test","baseBranch":"main"}\'::jsonb WHERE id=$1',
      [opId],
    );
    const { getUpdates } = await import("../src/server/operations/handlers");
    const history = async () => {
      const response = await getUpdates(
        new Request("http://localhost/api/updates"),
        { params: Promise.resolve({}) },
      );
      assert.equal(response.status, 200);
      return (await response.json()).updates;
    };
    assert.equal((await history())[0].canRevise, true);
    const recovered = await Promise.all(
      Array.from({ length: 6 }, () => reviseUpdate(opId, user)),
    );
    assert.equal(new Set(recovered.map((r) => r.editSession.id)).size, 1);
    assert.equal(recovered[0].summary, "Keep text");
    assert.equal(recovered[0].editSession.baseCommit, baseCommit);
    assert.equal(recovered[0].editSession.baseMapRevision, baseMapRevision);
    assert.deepEqual(recovered[0].editSession.assets, {});
    assert.equal(
      (await query("SELECT id FROM metro_edit_sessions")).rowCount,
      2,
    );
    assert.equal(
      (await query("SELECT id FROM metro_pipeline_audit WHERE action='revise'"))
        .rowCount,
      1,
    );
    await assert.rejects(retryOperation(opId, user.id), {
      code: "operation_not_retryable",
    });
    assert.equal(await leaseOperation(opId), null);
    assert.equal(
      (await query("SELECT status FROM metro_operations WHERE id=$1", [opId]))
        .rows[0].status,
      "failed",
    );
    assert.equal(
      (
        await query("SELECT state FROM metro_outbox WHERE operation_id=$1", [
          opId,
        ])
      ).rows[0].state,
      "done",
    );
    assert.equal((await history())[0].canRevise, true);
    await query(
      "UPDATE metro_edit_sessions SET status='submitted' WHERE id=$1",
      [recovered[0].editSession.id],
    );
    assert.equal((await history())[0].canRevise, false);
    await query(
      "UPDATE metro_edit_sessions SET status='draft',expires_at=now()-interval '1 day' WHERE id=$1",
      [recovered[0].editSession.id],
    );
    assert.equal((await history())[0].canRevise, false);
    const administrator = {
      ...user,
      id: "management-admin",
      role: "admin" as const,
    };
    await query('INSERT INTO "user"(id,name,email) VALUES($1,$2,$3)', [
      administrator.id,
      "Admin",
      "admin@example.invalid",
    ]);
    const makeSource = async (status: string) => {
      const id = randomUUID();
      await query(
        `INSERT INTO metro_operations(id,kind,scope,idempotency_key,request_digest,actor_id,status,payload,checkpoint)
        VALUES($1::uuid,'update',$1::text,$1::text,'test',$2,$3,$4,$5)`,
        [
          id,
          user.id,
          status,
          JSON.stringify({
            baseCommit,
            baseMapRevision,
            summary: "Management test",
            details: "Original",
            issueNumbers: [],
          }),
          JSON.stringify({ repository: "local/test", baseBranch: "main" }),
        ],
      );
      await query(
        "INSERT INTO metro_outbox(operation_id,state) VALUES($1,'done')",
        [id],
      );
      return id;
    };
    const adminSource = await makeSource("failed");
    const adminDraft = await reviseUpdate(adminSource, administrator);
    assert.equal(
      (
        await query("SELECT owner_id FROM metro_edit_sessions WHERE id=$1", [
          adminDraft.editSession.id,
        ])
      ).rows[0].owner_id,
      administrator.id,
    );
    assert.equal(
      (
        await query("SELECT actor_id FROM metro_operations WHERE id=$1", [
          adminSource,
        ])
      ).rows[0].actor_id,
      user.id,
    );
    assert.equal(
      (await history()).find((item: { id: string }) => item.id === adminSource)
        .canRevise,
      false,
    );
    const { deleteUpdate } =
      await import("../src/server/operations/manage-updates");
    const deletedId = await makeSource("failed");
    await Promise.all(
      Array.from({ length: 6 }, () => deleteUpdate(deletedId, user)),
    );
    assert.equal(
      (
        await query(
          "SELECT id FROM metro_pipeline_audit WHERE operation_id=$1 AND action='delete-update'",
          [deletedId],
        )
      ).rowCount,
      1,
    );
    assert.equal(
      (
        await query(
          "SELECT payload->>'summary' AS summary FROM metro_operations WHERE id=$1",
          [deletedId],
        )
      ).rows[0].summary,
      "Management test",
    );
    assert.equal(await leaseOperation(deletedId), null);
    await assert.rejects(retryOperation(deletedId, administrator.id), {
      code: "operation_not_retryable",
    });
    assert.equal(
      (await history()).some((item: { id: string }) => item.id === deletedId),
      false,
    );
    const target = await makeSource("awaiting_review");
    mockPrSource = target;
    await query(
      "UPDATE metro_operations SET checkpoint=checkpoint||$2::jsonb,result=$3::jsonb WHERE id=$1",
      [
        target,
        JSON.stringify({ commitSha: "2".repeat(40) }),
        JSON.stringify({ prNumber: 42 }),
      ],
    );
    const { beginUpdateEdit } =
      await import("../src/server/operations/manage-updates");
    const editDrafts = await Promise.all(
      Array.from({ length: 6 }, () => beginUpdateEdit(target, administrator)),
    );
    assert.equal(new Set(editDrafts.map((d) => d.editSession.id)).size, 1);
    assert.equal(
      (
        await query(
          "SELECT id FROM metro_pipeline_audit WHERE operation_id=$1 AND action='begin-update-edit'",
          [target],
        )
      ).rowCount,
      1,
    );
    const { acceptOperation } = await import("../src/server/operations/store");
    const submissions = await Promise.allSettled(
      Array.from({ length: 6 }, () =>
        acceptOperation({
          kind: "close-update",
          scope: `close:${administrator.id}`,
          key: randomUUID(),
          actorId: administrator.id,
          payload: { updateId: target },
          authorize: async () => {},
        }),
      ),
    );
    assert.equal(submissions.filter((r) => r.status === "fulfilled").length, 1);
    for (const r of submissions)
      if (r.status === "rejected") assert.equal(r.reason.code, "update_busy");
    assert.equal(
      (await query("SELECT id FROM metro_operations WHERE kind='close-update'"))
        .rowCount,
      1,
    );
    const closeId = (
      await query("SELECT id FROM metro_operations WHERE kind='close-update'")
    ).rows[0].id;
    await query(
      "UPDATE metro_operations SET status='failed',checkpoint=checkpoint||'{\"autoRetry\":false}'::jsonb WHERE id=$1",
      [closeId],
    );
    await retryOperation(closeId, administrator.id);
    assert.equal(
      (
        await query("SELECT status FROM metro_operations WHERE id=$1", [
          closeId,
        ])
      ).rows[0].status,
      "accepted",
    );
    await assert.rejects(
      acceptOperation({
        kind: "close-update",
        scope: "another-close",
        key: randomUUID(),
        actorId: administrator.id,
        payload: { updateId: target },
        authorize: async () => {},
      }),
      { code: "update_busy" },
    );
    await query(
      "UPDATE metro_operations SET status='closed_unmerged' WHERE id=$1",
      [target],
    );
    await assert.rejects(deleteUpdate(target, administrator), {
      code: "update_busy",
    });
    // Regression: a completed but uncertain maintenance ref write blocks close
    // until authoritative read evidence is reconciled transactionally.
    const { reconcileCompletedMaintenance } =
      await import("../src/server/operations/maintenance");
    const oldHead = "2".repeat(40),
      plannedHead = "3".repeat(40);
    const makeUncertainRefresh = async () => {
      const updateId = await makeSource("awaiting_review");
      mockPrSource = updateId;
      mockPrHead = plannedHead;
      mockRefHead = plannedHead;
      const refreshId = randomUUID();
      await query(
        "UPDATE metro_operations SET checkpoint=checkpoint||$2::jsonb,result=$3::jsonb WHERE id=$1",
        [
          updateId,
          JSON.stringify({ commitSha: oldHead }),
          JSON.stringify({ prNumber: 42 }),
        ],
      );
      await query(
        `INSERT INTO metro_operations(id,kind,scope,idempotency_key,request_digest,actor_id,status,payload,checkpoint,error_code)
        VALUES($1::uuid,'refresh-update',$1::text,$1::text,'test',$2,'outcome_unknown',$3,$4,'outcome_unknown')`,
        [
          refreshId,
          user.id,
          JSON.stringify({
            updateId,
            headSha: oldHead,
            baseCommit,
            baseMapRevision,
          }),
          JSON.stringify({
            repository: "local/test",
            baseBranch: "main",
            refreshIntent: true,
            refreshCommit: plannedHead,
          }),
        ],
      );
      await query(
        "INSERT INTO metro_outbox(operation_id,state) VALUES($1,'done')",
        [refreshId],
      );
      return { updateId, refreshId };
    };
    const acceptClose = (updateId: string) =>
      acceptOperation({
        kind: "close-update",
        scope: `reconciled-close:${updateId}`,
        key: randomUUID(),
        actorId: administrator.id,
        payload: { updateId },
        authorize: async () => {},
      });
    const pendingRefresh = await makeUncertainRefresh();
    await assert.rejects(acceptClose(pendingRefresh.updateId), {
      code: "update_busy",
    });
    const resolutions = await Promise.all(
      Array.from({ length: 6 }, () =>
        reconcileCompletedMaintenance(
          pendingRefresh.updateId,
          administrator.id,
        ),
      ),
    );
    assert.equal(
      resolutions.reduce((sum, count) => sum + count, 0),
      1,
    );
    const sourceAfter = (
      await query("SELECT checkpoint FROM metro_operations WHERE id=$1", [
        pendingRefresh.updateId,
      ])
    ).rows[0].checkpoint;
    assert.equal(sourceAfter.commitSha, plannedHead);
    assert.equal(sourceAfter.originalCommitSha, oldHead);
    assert.equal(sourceAfter.maintenanceOperationId, pendingRefresh.refreshId);
    const refreshAfter = (
      await query(
        "SELECT status,error_code,result FROM metro_operations WHERE id=$1",
        [pendingRefresh.refreshId],
      )
    ).rows[0];
    assert.equal(refreshAfter.status, "succeeded");
    assert.equal(refreshAfter.error_code, null);
    assert.equal(refreshAfter.result.headSha, plannedHead);
    assert.equal(
      (
        await query("SELECT state FROM metro_outbox WHERE operation_id=$1", [
          pendingRefresh.refreshId,
        ])
      ).rows[0].state,
      "done",
    );
    assert.equal(
      (
        await query(
          "SELECT id FROM metro_pipeline_audit WHERE action='reconcile-refresh' AND operation_id=$1",
          [pendingRefresh.refreshId],
        )
      ).rowCount,
      1,
    );
    assert.equal(
      await reconcileCompletedMaintenance(
        pendingRefresh.updateId,
        administrator.id,
      ),
      0,
    );
    assert.equal(
      (await acceptClose(pendingRefresh.updateId)).status,
      "accepted",
    );

    for (const scenario of [
      "different-ref",
      "unavailable",
      "wrong-creator",
      "live-lease",
      "missing-plan",
      "racing-retry",
      "racing-source",
      "inactive",
      "demoted",
    ]) {
      const pending = await makeUncertainRefresh();
      if (scenario === "different-ref") mockRefHead = oldHead;
      if (scenario === "unavailable") providerUnavailable = true;
      if (scenario === "wrong-creator") wrongCreator = true;
      if (scenario === "live-lease")
        await query(
          "UPDATE metro_operations SET lease_until=now()+interval '1 minute' WHERE id=$1",
          [pending.refreshId],
        );
      if (scenario === "missing-plan")
        await query(
          "UPDATE metro_operations SET checkpoint=checkpoint-'refreshCommit' WHERE id=$1",
          [pending.refreshId],
        );
      if (scenario === "racing-retry")
        afterRefRead = async () => {
          await query(
            "UPDATE metro_operations SET status='accepted' WHERE id=$1",
            [pending.refreshId],
          );
        };
      if (scenario === "racing-source")
        afterRefRead = async () => {
          await query(
            "UPDATE metro_operations SET checkpoint=checkpoint||$2::jsonb WHERE id=$1",
            [pending.updateId, JSON.stringify({ commitSha: "4".repeat(40) })],
          );
        };
      if (scenario === "inactive") activeAccount = false;
      if (scenario === "demoted") activeRole = "collaborator";
      if (scenario === "inactive" || scenario === "demoted") {
        await assert.rejects(
          reconcileCompletedMaintenance(pending.updateId, administrator.id),
          { code: scenario === "inactive" ? "unauthorized" : "forbidden" },
        );
      } else
        assert.equal(
          await reconcileCompletedMaintenance(
            pending.updateId,
            administrator.id,
          ),
          0,
          scenario,
        );
      assert.equal(
        (
          await query("SELECT status FROM metro_operations WHERE id=$1", [
            pending.refreshId,
          ])
        ).rows[0].status,
        scenario === "racing-retry" ? "accepted" : "outcome_unknown",
        scenario,
      );
      await assert.rejects(acceptClose(pending.updateId), {
        code: "update_busy",
      });
      assert.equal(
        (
          await query(
            "SELECT id FROM metro_pipeline_audit WHERE action='reconcile-refresh' AND operation_id=$1",
            [pending.refreshId],
          )
        ).rowCount,
        0,
      );
      providerUnavailable = false;
      wrongCreator = false;
      afterRefRead = undefined;
      activeAccount = true;
      activeRole = "admin";
    }
    const { reconcileTerminalActions } =
      await import("../src/server/operations/reconcile-actions");
    const makeObsoleteAction = async (
      kind = "merge",
      status = "needs_reconciliation",
    ) => {
      const sourceId = await makeSource("closed_unmerged");
      await query("UPDATE metro_operations SET result=$2 WHERE id=$1", [
        sourceId,
        { prNumber: 42 },
      ]);
      const actionId = randomUUID();
      await query(
        `INSERT INTO metro_operations(id,kind,scope,idempotency_key,request_digest,actor_id,status,payload,checkpoint,error_code)
        VALUES($1::uuid,$2,$1::text,$1::text,'test',$3,$4,$5,$6,'stale_base_revision')`,
        [
          actionId,
          kind,
          administrator.id,
          status,
          { updateId: sourceId, headSha: oldHead },
          { repository: "local/test", baseBranch: "main" },
        ],
      );
      await query(
        "INSERT INTO metro_outbox(operation_id,state) VALUES($1,'failed')",
        [actionId],
      );
      return { sourceId, actionId };
    };
    mockPrState = "closed";
    for (const kind of [
      "merge",
      "close-update",
      "edit-update",
      "refresh-update",
    ]) {
      const obsolete = await makeObsoleteAction(
        kind,
        kind === "merge" ? "needs_reconciliation" : "failed",
      );
      mockPrMerged = kind === "edit-update";
      if (mockPrMerged)
        await query(
          "UPDATE metro_operations SET status='published' WHERE id=$1",
          [obsolete.sourceId],
        );
      const counts = await Promise.all(
        Array.from({ length: 6 }, () => reconcileTerminalActions()),
      );
      assert.equal(
        counts.reduce((sum, count) => sum + count, 0),
        1,
        kind,
      );
      const record = (
        await query(
          "SELECT status,checkpoint,error_code FROM metro_operations WHERE id=$1",
          [obsolete.actionId],
        )
      ).rows[0];
      assert.equal(record.status, "superseded");
      assert.equal(record.error_code, null);
      assert.equal(
        record.checkpoint.reconciliation.previousError,
        "stale_base_revision",
      );
      assert.equal(
        record.checkpoint.reconciliation.reason,
        mockPrMerged ? "pr_merged" : "pr_closed_unmerged",
      );
      assert.equal(
        (
          await query("SELECT state FROM metro_outbox WHERE operation_id=$1", [
            obsolete.actionId,
          ])
        ).rows[0].state,
        "done",
      );
      assert.equal(
        (
          await query(
            "SELECT id FROM metro_pipeline_audit WHERE operation_id=$1 AND action='supersede-terminal-pr-action'",
            [obsolete.actionId],
          )
        ).rowCount,
        1,
      );
      assert.equal(await leaseOperation(obsolete.actionId), null);
      await assert.rejects(
        retryOperation(obsolete.actionId, administrator.id),
        { code: "operation_not_retryable" },
      );
      assert.equal(await reconcileTerminalActions(), 0);
      if (kind === "merge") {
        // A new independently authorized request must not deduplicate to a retired attempt.
        await query(
          "UPDATE metro_operations SET status='awaiting_review' WHERE id=$1",
          [obsolete.sourceId],
        );
        const replacement = await acceptOperation({
          kind: "merge",
          scope: "new-merge",
          key: randomUUID(),
          actorId: administrator.id,
          payload: { updateId: obsolete.sourceId, headSha: oldHead },
          authorize: async () => {},
        });
        assert.notEqual(replacement.id, obsolete.actionId);
        assert.equal(replacement.status, "accepted");
      }
    }
    mockPrMerged = false;
    for (const scenario of [
      "open",
      "unavailable",
      "wrong-creator",
      "wrong-repo",
      "live-action",
      "live-source",
      "unknown",
      "intent",
      "publication",
      "racing-retry",
      "racing-intent",
      "source-reopened",
    ]) {
      const obsolete = await makeObsoleteAction(
        "merge",
        scenario === "unknown" ? "outcome_unknown" : "failed",
      );
      if (scenario === "open") mockPrState = "open";
      if (scenario === "unavailable") prUnavailable = true;
      if (scenario === "wrong-creator") wrongCreator = true;
      if (scenario === "wrong-repo")
        await query(
          'UPDATE metro_operations SET checkpoint=checkpoint||\'{"repository":"other/test"}\'::jsonb WHERE id=$1',
          [obsolete.actionId],
        );
      if (scenario === "live-action" || scenario === "live-source")
        await query(
          "UPDATE metro_operations SET lease_until=now()+interval '1 minute' WHERE id=$1",
          [scenario === "live-action" ? obsolete.actionId : obsolete.sourceId],
        );
      if (scenario === "intent")
        await query(
          "UPDATE metro_operations SET checkpoint=checkpoint||'{\"mergeIntent\":true}'::jsonb WHERE id=$1",
          [obsolete.actionId],
        );
      if (scenario === "publication")
        await query(
          "UPDATE metro_operations SET result='{\"publicationPending\":true}'::jsonb WHERE id=$1",
          [obsolete.actionId],
        );
      if (scenario === "racing-retry")
        afterPrRead = async () => {
          await retryOperation(obsolete.actionId, administrator.id);
        };
      if (scenario === "racing-intent")
        afterPrRead = async () => {
          await query(
            "UPDATE metro_operations SET checkpoint=checkpoint||'{\"mergeIntent\":true}'::jsonb WHERE id=$1",
            [obsolete.actionId],
          );
        };
      if (scenario === "source-reopened")
        afterPrRead = async () => {
          await query(
            "UPDATE metro_operations SET status='awaiting_review' WHERE id=$1",
            [obsolete.sourceId],
          );
        };
      assert.equal(await reconcileTerminalActions(), 0, scenario);
      assert.notEqual(
        (
          await query("SELECT status FROM metro_operations WHERE id=$1", [
            obsolete.actionId,
          ])
        ).rows[0].status,
        "superseded",
        scenario,
      );
      await query(
        'UPDATE metro_operations SET checkpoint=checkpoint||\'{"repository":"excluded/test"}\'::jsonb WHERE id=$1',
        [obsolete.sourceId],
      );
      mockPrState = "closed";
      prUnavailable = false;
      wrongCreator = false;
      afterPrRead = undefined;
    }
    console.log(
      "PASS: obsolete merge/close/edit/maintenance actions reconcile once across concurrent scans, retain error history and cannot retry/lease; open/mismatched/unavailable PRs, live leases, uncertain writes, publication failures and racing retries remain untouched.",
    );
    console.log(
      "PASS: observed completed maintenance reconciles once across six concurrent requests and unblocks close; changed/unavailable evidence, live leases, racing retries/source changes and revoked roles preserve blockers. Provider mocks expose no mutation methods.",
    );
    console.log(
      "PASS: administrator recovery preserves contributor; concurrent deletion records one audit, hides history and blocks leases/retries; six concurrent PR-edit requests reuse one draft without pool exhaustion; concurrent PR actions accept exactly one durable operation.",
    );
    console.log(
      "PASS: saved history exposes safe recovery, resumes active replacements, and hides submitted or expired replacements.",
    );
    console.log(
      "PASS: six concurrent recoveries create one pinned draft and audit; replaced operation cannot retry or lease.",
    );
  } finally {
    await getPool().end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
}
main().catch((error) => {
  console.error(
    "Recovery acceptance failed:",
    error instanceof Error ? error.message : "Unknown error",
  );
  process.exitCode = 1;
});
