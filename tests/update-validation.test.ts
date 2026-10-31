import assert from "node:assert/strict";
import { before, beforeEach, mock, test } from "node:test";
import sharp from "sharp";
const user = {
  id: "owner",
  name: "Player",
  role: "collaborator" as const,
  email: "p@example.invalid",
};
const sessionId = "11111111-1111-4111-8111-111111111111";
const jsonId = "22222222-2222-4222-8222-222222222222";
const pngId = "33333333-3333-4333-8333-333333333333";
let json: Buffer, png: Buffer;
let writes: string[];
let contentType: string;
const record = (kind: string) => ({
  id: kind === "json" ? jsonId : pngId,
  kind,
  owner_id: user.id,
  edit_session_id: sessionId,
  pathname: `staging/${kind}`,
  size: (kind === "json" ? json : png).length,
  status: "ready",
  expires_at: new Date(Date.now() + 100000),
});
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
    transaction: async () => {
      writes.push("transaction");
      throw new Error("Must reject before accepting an operation");
    },
    query: async (sql: string, params: string[]) => {
      if (sql.startsWith("SELECT * FROM metro_operations")) return { rows: [] };
      if (sql.startsWith("SELECT * FROM metro_edit_sessions"))
        return {
          rows: [
            {
              id: sessionId,
              owner_id: user.id,
              status: "draft",
              expires_at: new Date(Date.now() + 100000),
              base_revision: `sha256:${"a".repeat(64)}`,
            },
          ],
        };
      if (sql.startsWith("SELECT DISTINCT ON(kind)"))
        return { rows: [record("json"), record("png")] };
      if (sql.startsWith("SELECT * FROM metro_uploads"))
        return { rows: [record(params[0] === jsonId ? "json" : "png")] };
      writes.push(sql);
      return { rows: [record(params[0] === jsonId ? "json" : "png")] };
    },
  },
});
mock.module("../src/server/auth/authorize.ts", {
  namedExports: { requireCollaborator: async () => user },
});
mock.module("../src/server/security/index.ts", {
  namedExports: { enforceSameOrigin: () => {} },
});
mock.module("@vercel/blob", {
  namedExports: {
    head: async (pathname: string) => ({
      pathname,
      size: (pathname.endsWith("json") ? json : png).length,
      contentType,
      url: "https://example.invalid/file",
    }),
    get: async (pathname: string) => ({
      statusCode: 200,
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue(pathname.endsWith("json") ? json : png);
          controller.close();
        },
      }),
    }),
  },
});
let completeUpload: typeof import("../src/server/storage/staging").completeUpload;
let postUpdate: typeof import("../src/server/operations/handlers").postUpdate;
before(async () => {
  process.env.BLOB_READ_WRITE_TOKEN = "test-token";
  ({ completeUpload } = await import("../src/server/storage/staging"));
  ({ postUpdate } = await import("../src/server/operations/handlers"));
  png = await sharp({
    create: { width: 2, height: 2, channels: 4, background: "#fff" },
  })
    .png()
    .toBuffer();
});
beforeEach(() => {
  writes = [];
  contentType = "application/json";
  json = Buffer.from(
    JSON.stringify({
      version: 81,
      mapEnabled: false,
      mapStyle: {},
      svgViewBoxZoom: 100,
      svgViewBoxMin: { x: 0, y: 0 },
      images: [],
      graph: { options: {}, attributes: {}, nodes: [], edges: [] },
    }),
  );
});
test("completion validates actual JSON content before ready and accepts RMP 81", async () => {
  json = Buffer.from("not JSON");
  await assert.rejects(completeUpload(jsonId, user), { code: "invalid_json" });
  assert.deepEqual(writes, []);
});
test("completion accepts RMP 81 only after reading validated bytes", async () => {
  await completeUpload(jsonId, user);
  assert.equal(writes.length, 1);
  assert.match(writes[0], /status='ready'/);
});
test("completion rejects corrupt PNG before ready", async () => {
  const previous = png;
  png = Buffer.from("not PNG");
  contentType = "image/png";
  try {
    await assert.rejects(completeUpload(pngId, user), { code: "invalid_png" });
    assert.deepEqual(writes, []);
  } finally {
    png = previous;
  }
});
for (const [name, bytes, code] of [
  ["malformed JSON", "{", "invalid_json"],
  [
    "invalid RMP version metadata",
    '{"version":-1,"graph":{}}',
    "unsupported_map_format",
  ],
  ["invalid graph", '{"version":81,"graph":{}}', "invalid_map_document"],
]) {
  test(`submission rejects legacy ready ${name} before operation acceptance`, async () => {
    json = Buffer.from(bytes);
    const response = await postUpdate(
      new Request("http://localhost/api/updates", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": "44444444-4444-4444-8444-444444444444",
        },
        body: JSON.stringify({
          editSessionId: sessionId,
          summary: "Update map",
          details: "",
          issueNumbers: [],
        }),
      }),
      { params: Promise.resolve({}) },
    );
    assert.equal(response.status, 422);
    assert.equal((await response.json()).error.code, code);
    assert.deepEqual(writes, []);
  });
}
