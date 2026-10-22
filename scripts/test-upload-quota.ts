/** Local PostgreSQL quota acceptance; isolated schema, no Blob or GitHub writes. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { mock } from "node:test";
import { Client } from "pg";

mock.module("../src/server/github/client.ts", { namedExports: {} });
mock.module("../src/server/auth/authorize.ts", { namedExports: {} });

async function main() {
  const connection = process.env.DATABASE_URL;
  if (!connection) throw new Error("A local test database is required.");
  const url = new URL(connection);
  if (
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    !/(test|dev)/i.test(url.pathname)
  )
    throw new Error("Upload quota tests require a local test/dev database.");
  const schema = `upload_quota_${randomUUID().replaceAll("-", "")}`;
  const admin = new Client({ connectionString: connection });
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${schema}`);
  url.searchParams.set("options", `-c search_path=${schema}`);
  process.env.DATABASE_URL = url.toString();
  const { query, getPool } = await import("../src/server/db/index");
  try {
    for (const name of ["001_accounts.sql", "002_pipeline.sql"])
      await query(await readFile(`migrations/${name}`, "utf8"));
    for (const id of ["owner", "other"])
      await query('INSERT INTO "user"(id,name,email) VALUES($1,$1,$2)', [
        id,
        `${id}@example.invalid`,
      ]);
    const sessionId = randomUUID(),
      otherSessionId = randomUUID();
    for (const [id, owner] of [
      [sessionId, "owner"],
      [otherSessionId, "other"],
    ])
      await query(
        "INSERT INTO metro_edit_sessions(id,owner_id,base_commit,base_revision,expires_at) VALUES($1,$2,$3,$4,now()+interval '1 day')",
        [id, owner, "1".repeat(40), `sha256:${"a".repeat(64)}`],
      );
    const { reserveUpload } = await import("../src/server/storage/staging");
    const user = {
      id: "owner",
      name: "Player",
      email: "owner@example.invalid",
      role: "collaborator" as const,
    };
    const mib = 1024 * 1024;
    async function seed(
      count: number,
      kind: "json" | "png",
      status: string,
      size: number | null,
      owner = "owner",
    ) {
      const reserved = (kind === "json" ? 2 : 20) * mib;
      for (let i = 0; i < count; i++) {
        const id = randomUUID();
        await query(
          `INSERT INTO metro_uploads(id,edit_session_id,owner_id,kind,pathname,reserved_bytes,size,status,expires_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,now()-interval '1 day')`,
          [
            id,
            owner === "owner" ? sessionId : otherSessionId,
            owner,
            kind,
            `staging/test/${id}`,
            reserved,
            size,
            status,
          ],
        );
      }
    }
    const reset = () => query("DELETE FROM metro_uploads");
    await seed(5, "png", "ready", 3 * mib);
    await seed(6, "json", "ready", 200000);
    const reserved = await reserveUpload(user, sessionId, "png");
    assert.equal(Number(reserved.reserved_bytes), 20 * mib);
    console.log(
      "PASS: existing ready uploads use actual sizes; the reported local scenario can reserve another PNG.",
    );

    await reset();
    await seed(6, "png", "reserved", null);
    await seed(4, "json", "reserved", null);
    await assert.rejects(reserveUpload(user, sessionId, "json"), {
      code: "storage_quota_exceeded",
      status: 429,
    });
    assert.equal((await query("SELECT id FROM metro_uploads")).rowCount, 10);
    console.log(
      "PASS: unfinished uploads retain full reservations; account quota rejects without inserting a row.",
    );

    await reset();
    await seed(6, "png", "ready", null);
    await assert.rejects(reserveUpload(user, sessionId, "png"), {
      code: "storage_quota_exceeded",
    });
    console.log("PASS: missing trusted sizes fall back to full reservations.");

    await reset();
    await seed(8, "png", "deleted", 20 * mib);
    await reserveUpload(user, sessionId, "png");
    console.log("PASS: deleted objects do not consume quota.");

    await reset();
    await seed(51, "png", "reserved", null, "other");
    await seed(2, "json", "reserved", null, "other");
    await assert.rejects(reserveUpload(user, sessionId, "json"), {
      code: "storage_quota_exceeded",
    });
    console.log("PASS: global quota includes other owners.");

    await reset();
    await seed(5, "png", "reserved", null);
    await seed(3, "json", "reserved", null);
    const results = await Promise.allSettled([
      reserveUpload(user, sessionId, "png"),
      reserveUpload(user, sessionId, "png"),
    ]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    const failed = results.find(
      (r) => r.status === "rejected",
    ) as PromiseRejectedResult;
    assert.equal(failed.reason.code, "storage_quota_exceeded");
    console.log(
      "PASS: concurrent reservations cannot overbook the account limit.",
    );
  } finally {
    await getPool().end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
}
main().catch((error) => {
  console.error(
    "Upload quota acceptance failed:",
    error instanceof Error ? error.message : "Unknown error",
  );
  process.exitCode = 1;
});
