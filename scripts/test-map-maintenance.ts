/** Isolated PostgreSQL acceptance for maintenance intent/outbox deduplication. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { mock } from "node:test";
import { Client } from "pg";
const head = "1".repeat(40),
  prHead = "2".repeat(40);
const manifest = readFileSync("map-data/maps/manifest.json");
mock.module("../src/server/github/client.ts", {
  namedExports: {
    repositoryConfig: () => ({
      owner: "local",
      repo: "test",
      key: "local/test",
      branch: "main",
    }),
    currentHead: async () => head,
    readFileAt: async () => manifest,
    MAP_PATHS: {
      json: "maps/network.json",
      png: "maps/network.png",
      manifest: "maps/manifest.json",
    },
  },
});
mock.module("../src/server/auth/config.ts", {
  namedExports: {
    getAuth: () => {
      throw new Error("No browser authentication.");
    },
  },
});
mock.module("../src/server/operations/outbox.ts", {
  namedExports: { launchOperation: async () => {} },
});
async function main() {
  const connection = process.env.DATABASE_URL;
  if (!connection) throw new Error("Local test database required.");
  const url = new URL(connection);
  if (
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    !/test|dev/i.test(url.pathname)
  )
    throw new Error("Local test/dev database required.");
  const schema = `map_maintenance_${randomUUID().replaceAll("-", "")}`;
  const admin = new Client({ connectionString: connection });
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${schema}`);
  url.searchParams.set("options", `-c search_path=${schema}`);
  process.env.DATABASE_URL = url.toString();
  const { query, getPool } = await import("../src/server/db/index");
  try {
    for (const name of ["001_accounts.sql", "002_pipeline.sql"])
      await query(await readFile(`migrations/${name}`, "utf8"));
    const owner = randomUUID(),
      id = randomUUID();
    await query('INSERT INTO "user"(id,name,email) VALUES($1,$1,$2)', [
      owner,
      `${owner}@example.invalid`,
    ]);
    await query(
      "INSERT INTO metro_profiles(user_id,role,active) VALUES($1,'collaborator',true)",
      [owner],
    );
    const revision = JSON.parse(manifest.toString()).map_revision;
    await query(
      `INSERT INTO metro_operations(id,kind,scope,idempotency_key,request_digest,actor_id,status,payload,checkpoint)
      VALUES($1::uuid,'update','fixture',$1::text,'fixture',$2,'awaiting_review',$3,$4)`,
      [
        id,
        owner,
        JSON.stringify({ baseMapRevision: revision }),
        JSON.stringify({
          repository: "local/test",
          baseBranch: "main",
          commitSha: prHead,
        }),
      ],
    );
    const { queueMaintenanceSync, queuePendingMaintenance } =
      await import("../src/server/operations/maintenance");
    const { leaseOperation, checkpoint, finishOperation } =
      await import("../src/server/operations/store");
    const queued = await Promise.all(
      Array.from({ length: 8 }, () => queueMaintenanceSync(id, prHead, head)),
    );
    assert.equal(new Set(queued.map((op) => op.id)).size, 1);
    assert.equal(
      (await query("SELECT operation_id FROM metro_outbox")).rowCount,
      1,
    );
    await queuePendingMaintenance();
    assert.equal(
      (
        await query(
          "SELECT id FROM metro_operations WHERE kind='refresh-update'",
        )
      ).rowCount,
      1,
    );
    console.log(
      "PASS: eight concurrent requests and background reconciliation share one durable operation/outbox.",
    );
    const lease = await leaseOperation(queued[0].id);
    assert.ok(lease);
    await checkpoint(lease.op.id, lease.token, {
      refreshCommit: "3".repeat(40),
      refreshIntent: true,
    });
    await finishOperation(
      lease.op.id,
      lease.token,
      "outcome_unknown",
      {},
      "outcome_unknown",
    );
    const unknown = await queueMaintenanceSync(id, prHead, head);
    assert.equal(unknown.status, "outcome_unknown");
    assert.equal(unknown.checkpoint.refreshIntent, true);
    assert.equal(unknown.checkpoint.refreshCommit, "3".repeat(40));
    assert.equal(
      (await query("SELECT state FROM metro_outbox")).rows[0].state,
      "done",
    );
    console.log(
      "PASS: automatic queue calls preserve uncertain ref-write intent without scheduling a second write.",
    );
    await query("UPDATE metro_profiles SET active=false WHERE user_id=$1", [
      owner,
    ]);
    await queuePendingMaintenance();
    assert.equal(
      (
        await query(
          "SELECT id FROM metro_operations WHERE kind='refresh-update'",
        )
      ).rowCount,
      1,
    );
    await query("UPDATE metro_profiles SET active=true WHERE user_id=$1", [
      owner,
    ]);
    await query(
      'UPDATE metro_operations SET payload=payload||\'{"baseMapRevision":"different-map"}\'::jsonb WHERE id=$1',
      [id],
    );
    await queuePendingMaintenance();
    assert.equal(
      (
        await query(
          "SELECT id FROM metro_operations WHERE kind='refresh-update'",
        )
      ).rowCount,
      1,
    );
    console.log(
      "PASS: background catch-up skips inactive authors and submissions based on a different map.",
    );
  } finally {
    await getPool().end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
}
main().catch((error) => {
  console.error("Maintenance database acceptance failed", {
    type: error?.name,
    code: error?.code,
    message: error?.message,
  });
  process.exitCode = 1;
});
