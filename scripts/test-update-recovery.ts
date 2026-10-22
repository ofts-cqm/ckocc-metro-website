/** Isolated local PostgreSQL recovery acceptance; no provider writes. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { mock } from "node:test";
import { Client } from "pg";

// Recovery needs no GitHub calls. Keep provider initialization out of this check.
mock.module("../src/server/github/client.ts", {
  namedExports: {
    repositoryConfig: () => ({ key: "local/test", branch: "main" }),
    githubConfigured: () => false,
    MAP_PATHS: {},
  },
});
mock.module("../src/server/auth/authorize.ts", {
  namedExports: {
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
      'UPDATE metro_operations SET checkpoint=checkpoint||\'{"repository":"local/test"}\'::jsonb WHERE id=$1',
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
