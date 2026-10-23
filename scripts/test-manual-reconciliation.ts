/** Isolated PostgreSQL acceptance. No provider writes; refuses remote targets. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Client, Pool } from "pg";
import {
  reconcileOperations,
  loadOperation,
  applyDecision,
  inspectOperation,
} from "./lib/reconcile-operations";

async function main() {
  const url = new URL(process.env.DATABASE_URL || "http://invalid");
  assert.ok(
    ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) &&
      /(test|dev)/i.test(url.pathname),
    "Local test/dev database required",
  );
  const admin = new Client({ connectionString: url.toString() });
  await admin.connect();
  const schema = `manual_reconcile_${randomUUID().replaceAll("-", "")}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  url.searchParams.set("options", `-c search_path=${schema}`);
  const pool = new Pool({ connectionString: url.toString() });
  const ctx = {
    repository: "local/test",
    branch: "main",
    bot: "metro[bot]",
    readPull: async (number: number) => ({
      number,
      repository: "local/test",
      creator: "metro[bot]",
      state: "closed",
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
    }),
  };
  const silent = () => {};
  try {
    for (const migration of ["001_accounts.sql", "002_pipeline.sql"])
      await pool.query(await readFile(`migrations/${migration}`, "utf8"));
    const ids = Array.from({ length: 105 }, () => randomUUID());
    for (const id of ids) {
      await pool.query(
        `INSERT INTO metro_operations(id,kind,scope,idempotency_key,request_digest,status,payload,checkpoint,error_code)
        VALUES($1::uuid,'update',$1::text,$1::text,'test','failed','{}',$2,'unsupported_map_format')`,
        [
          id,
          {
            repository: ctx.repository,
            baseBranch: "main",
            deletedAt: new Date().toISOString(),
            autoRetry: false,
          },
        ],
      );
      await pool.query(
        "INSERT INTO metro_outbox(operation_id,state) VALUES($1,'failed')",
        [id],
      );
    }
    const preview = await reconcileOperations(pool, ctx, false, silent);
    assert.equal(preview.scanned, 105);
    assert.equal(preview.proposed, 105);
    assert.equal(preview.applied, 0);
    assert.equal(
      (await pool.query("SELECT count(*)::int n FROM metro_pipeline_audit"))
        .rows[0].n,
      0,
    );
    const concurrent = await Promise.all(
      Array.from({ length: 6 }, () =>
        reconcileOperations(pool, ctx, true, silent),
      ),
    );
    assert.equal(
      concurrent.reduce((n, r) => n + r.applied, 0),
      105,
    );
    assert.equal(
      (await pool.query("SELECT count(*)::int n FROM metro_pipeline_audit"))
        .rows[0].n,
      105,
    );
    assert.equal(
      (
        await pool.query(
          "SELECT count(*)::int n FROM metro_outbox WHERE state='done'",
        )
      ).rows[0].n,
      105,
    );
    assert.equal(
      (
        await pool.query(
          "SELECT count(*)::int n FROM metro_operations WHERE checkpoint->'reconciliation'->>'previousError'='unsupported_map_format'",
        )
      ).rows[0].n,
      105,
    );
    assert.equal(
      (await reconcileOperations(pool, ctx, true, silent)).applied,
      0,
    );
    await pool.query(
      "UPDATE metro_operations SET status='failed' WHERE id=$1",
      [ids[0]],
    );
    const before = (await loadOperation(pool, ids[0]))!;
    const decision = await inspectOperation(before, ctx, async () => undefined);
    await pool.query(
      "UPDATE metro_operations SET status='accepted' WHERE id=$1",
      [ids[0]],
    );
    assert.equal(await applyDecision(pool, before, decision), false);
    assert.equal((await loadOperation(pool, ids[0]))!.status, "accepted");
    // Parent changes after provider observation must also prevent retirement.
    const actionId = randomUUID();
    await pool.query(
      "UPDATE metro_operations SET status='closed_unmerged',result='{\"prNumber\":42}' WHERE id=$1",
      [ids[0]],
    );
    await pool.query(
      `INSERT INTO metro_operations(id,kind,scope,idempotency_key,request_digest,status,payload,checkpoint)
      VALUES($1::uuid,'merge',$1::text,$1::text,'test','failed',$2,$3)`,
      [
        actionId,
        { updateId: ids[0] },
        { repository: ctx.repository, baseBranch: "main" },
      ],
    );
    const action = (await loadOperation(pool, actionId))!;
    const plan = await inspectOperation(action, ctx, (id) =>
      loadOperation(pool, id),
    );
    assert.equal(plan.status, "superseded");
    await pool.query(
      "UPDATE metro_operations SET status='awaiting_review' WHERE id=$1",
      [ids[0]],
    );
    assert.equal(await applyDecision(pool, action, plan), false);
    console.log(
      "PASS: 105-row preview, concurrent single audits, retained errors, completed outboxes, idempotency, retry/source races.",
    );
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
}
main().catch((error) => {
  console.error("Manual reconciliation acceptance failed.", {
    code: error.code,
    assertion: error.code === "ERR_ASSERTION" ? error.message : undefined,
  });
  process.exitCode = 1;
});
