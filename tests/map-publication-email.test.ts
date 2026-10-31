import assert from "node:assert/strict";
import { before, beforeEach, mock, test } from "node:test";
let prior: Record<string, unknown> | undefined;
let events: unknown[][];
let writes: string[];
let headCalls: number;
let outdated: boolean;
let launchFails: boolean;
let launches: number;
const commit = "current";
mock.module("../src/server/email/jobs.ts", {
  namedExports: {
    launchPublicationEmailDrain: async () => {
      assert.ok(writes.includes("COMMIT"), "launch must follow pointer commit");
      launches++;
      if (launchFails) throw new Error("workflow unavailable");
    },
  },
});
mock.module("../src/server/db/index.ts", {
  namedExports: {
    query: async () => ({ rows: [] }),
    getPool: () => ({
      connect: async () => ({
        release() {},
        query: async (sql: string, values: unknown[] = []) => {
          writes.push(sql);
          if (sql.includes("pg_try_advisory"))
            return { rows: [{ locked: true }] };
          if (sql.includes("SELECT * FROM metro_publications"))
            return { rows: prior ? [prior] : [] };
          if (sql.includes("INSERT INTO metro_map_publication_events"))
            events.push(values);
          return { rows: [] };
        },
      }),
    }),
  },
});
mock.module("../src/server/github/client.ts", {
  namedExports: {
    repositoryConfig: () => ({ key: "test/map" }),
    currentHead: async () => (++headCalls > 1 && outdated ? "newer" : commit),
    MAP_PATHS: { manifest: "manifest", json: "json", png: "png" },
    readFileAt: async () => Buffer.from("content"),
  },
});
mock.module("../src/server/maps/validate.ts", {
  namedExports: {
    MAP_LIMITS: { json: 100, png: 100 },
    parseManifest: () => ({
      summary: "Restored map",
      map_revision: "revision",
    }),
    validatePair: async () => ({
      revision: "revision",
      jsonHash: "json",
      pngHash: "png",
      image: { width: 1, height: 1 },
    }),
  },
});
mock.module("../src/server/storage/staging.ts", {
  namedExports: {
    publishImage: async () => ({ imageUrl: "image", overviewUrl: "overview" }),
  },
});
let synchronizePublication: typeof import("../src/server/maps/publication").synchronizePublication;
before(async () => {
  ({ synchronizePublication } = await import("../src/server/maps/publication"));
});
beforeEach(() => {
  prior = undefined;
  events = [];
  writes = [];
  headCalls = 0;
  outdated = false;
  launchFails = false;
  launches = 0;
});
test("changed publication records notification intent before the pointer transaction commits", async () => {
  prior = { commit_sha: "old", json_sha: "old-json", png_sha: "old-png" };
  await synchronizePublication();
  assert.deepEqual(events, [["test/map", commit, "revision", "Restored map"]]);
  assert.match(
    writes.find((sql) =>
      sql.includes("INSERT INTO metro_map_publication_events"),
    )!,
    /clock_timestamp\(\)/,
  );
  assert.ok(
    writes.findIndex((sql) =>
      sql.includes("INSERT INTO metro_map_publication_events"),
    ) < writes.indexOf("COMMIT"),
  );
});
test("same content maintenance commits and duplicate delivery do not notify", async () => {
  for (const sha of ["old", commit]) {
    prior = { commit_sha: sha, json_sha: "json", png_sha: "png" };
    await synchronizePublication();
    assert.equal(events.length, 0);
  }
});
test("outdated validation never moves the pointer or records notification intent", async () => {
  outdated = true;
  await assert.rejects(synchronizePublication());
  assert.equal(events.length, 0);
  assert.ok(writes.includes("ROLLBACK"));
  assert.ok(
    !writes.some((sql) => sql.includes("INSERT INTO metro_publications")),
  );
});

test("workflow launch failure preserves successful publication and durable intent", async () => {
  launchFails = true;
  const result = await synchronizePublication();
  assert.equal(result.commitSha, commit);
  assert.equal(events.length, 1);
  assert.equal(launches, 1);
  assert.ok(!writes.includes("ROLLBACK"));
});
