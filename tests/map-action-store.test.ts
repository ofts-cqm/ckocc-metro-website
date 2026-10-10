import assert from "node:assert/strict";
import { before, beforeEach, mock, test } from "node:test";
import type { Operation } from "../src/server/operations/store";

let existing: Operation | undefined;
let inserted = 0,
  audited = 0,
  authorized = 0;
mock.module("../src/server/github/client.ts", {
  namedExports: {
    repositoryConfig: () => ({ key: "test/map", branch: "main" }),
  },
});
mock.module("../src/server/db/index.ts", {
  namedExports: {
    query: async () => ({ rows: [] }),
    transaction: async (run: (client: unknown) => Promise<unknown>) =>
      run({
        query: async (sql: string, params: unknown[]) => {
          if (sql.includes("SELECT * FROM metro_operations WHERE kind="))
            return { rows: existing ? [existing] : [] };
          if (sql.includes("INSERT INTO metro_operations")) {
            inserted++;
            return {
              rows: [
                {
                  id: params[0],
                  kind: params[1],
                  payload: JSON.parse(String(params[8])),
                },
              ],
            };
          }
          if (sql.includes("INSERT INTO metro_pipeline_audit")) audited++;
          if (
            sql.includes("metro_edit_sessions") ||
            sql.includes("metro_uploads")
          )
            assert.fail("Rollback must not require an edit session or uploads");
          return { rows: [] };
        },
      }),
  },
});
let acceptOperation: typeof import("../src/server/operations/store").acceptOperation;
before(async () => {
  ({ acceptOperation } = await import("../src/server/operations/store"));
});
beforeEach(() => {
  existing = undefined;
  inserted = audited = authorized = 0;
});
const input = (kind: "merge" | "rollback", key = "second-browser-key") => ({
  kind,
  key,
  scope: `${kind}:second-admin`,
  actorId: "second-admin",
  payload: {
    updateId: "source",
    baseCommit: "1".repeat(40),
    headSha: "2".repeat(40),
  },
  authorize: async () => {
    authorized++;
  },
});
for (const kind of ["merge", "rollback"] as const) {
  test(`${kind}: another administrator receives the existing operation without another write`, async () => {
    existing = { id: "first-operation", actor_id: "first-admin" } as Operation;
    const result = await acceptOperation(input(kind));
    assert.equal(result.id, "first-operation");
    assert.equal(inserted, 0);
    assert.equal(authorized, 1);
  });
  test(`${kind}: a new action records its administrator audit and durable operation`, async () => {
    await acceptOperation(input(kind));
    assert.equal(inserted, 1);
    assert.equal(audited, 1);
    assert.equal(authorized, 1);
  });
}
