import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { before, mock, test } from "node:test";
const historical = JSON.parse(
  readFileSync("map-data/maps/manifest.json", "utf8"),
);
const rollbackId = "00000000-0000-4000-8000-000000000042";
const restored = { ...historical, operation_id: rollbackId };
const commit = "a".repeat(40);
let publishedId: unknown;
mock.module("../src/server/db/index.ts", {
  namedExports: {
    query: async () => ({ rows: [] }),
    getPool: () => ({
      connect: async () => ({
        release() {},
        query: async (sql: string, params: unknown[]) => {
          if (sql.includes("pg_try_advisory"))
            return { rows: [{ locked: true }] };
          if (sql.includes("SELECT * FROM metro_publications"))
            return { rows: [{ commit_sha: commit }] };
          if (sql.includes("UPDATE metro_operations")) {
            // A repeated map revision must identify its new publication operation.
            assert.ok(sql.includes("id::text=$2"));
            assert.equal(params[0], historical.map_revision);
            publishedId = params[1];
          }
          return { rows: [] };
        },
      }),
    }),
  },
});
mock.module("../src/server/github/client.ts", {
  namedExports: {
    repositoryConfig: () => ({ key: "test/map" }),
    currentHead: async () => commit,
    MAP_PATHS: { manifest: "maps/manifest.json" },
    readFileAt: async () => Buffer.from(JSON.stringify(restored)),
  },
});
let synchronizePublication: typeof import("../src/server/maps/publication").synchronizePublication;
before(async () => {
  ({ synchronizePublication } = await import("../src/server/maps/publication"));
});
test("publishing restored content marks the rollback operation, not every historical matching hash", async () => {
  const result = await synchronizePublication();
  assert.equal(result.revision, historical.map_revision);
  assert.equal(publishedId, rollbackId);
});
