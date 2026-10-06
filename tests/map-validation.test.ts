import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import {
  mapRevision,
  parseManifest,
  validateDocument,
  validatePair,
  validatePng,
  type MapManifest,
} from "../src/server/maps/validate";
import { AppError } from "../src/server/http";

const code = (expected: string) => (error: unknown) =>
  error instanceof AppError && error.code === expected;

function document() {
  return {
    version: 80,
    mapEnabled: false,
    mapStyle: {},
    svgViewBoxZoom: 100,
    svgViewBoxMin: { x: 0, y: 0 },
    images: [],
    extensionData: { preserve: "原文" },
    graph: {
      options: {},
      attributes: {},
      nodes: [
        { key: "a", attributes: { type: "test-station", x: 1, y: 2 } },
        { key: "b", attributes: { type: "test-station", x: 3, y: 4 } },
      ],
      edges: [{ key: "ab", source: "a", target: "b", attributes: {} }],
    },
  };
}
const bytes = (input: unknown) => Buffer.from(JSON.stringify(input));

test("map validation rejects duplicate keys, broken graph references and unsupported versions", () => {
  const duplicate = document();
  duplicate.graph.nodes[1].key = "a";
  assert.throws(
    () => validateDocument(bytes(duplicate)),
    code("invalid_map_graph"),
  );
  const broken = document();
  broken.graph.edges[0].target = "missing";
  assert.throws(
    () => validateDocument(bytes(broken)),
    code("invalid_map_graph"),
  );
  const future = document();
  future.version = 81;
  assert.throws(
    () => validateDocument(bytes(future)),
    code("unsupported_map_format"),
  );
  assert.throws(
    () => validateDocument(Buffer.from([0xff, 0xfe])),
    code("invalid_json"),
  );
});

test("validating an export preserves its exact bytes and accepts unknown editor fields", () => {
  const input = Buffer.from(JSON.stringify(document(), null, 4) + "\n");
  const before = Buffer.from(input);
  assert.deepEqual(validateDocument(input), {
    format: { id: "rail-map-painter", document_version: 80 },
    nodes: 2,
    edges: 1,
  });
  assert.deepEqual(input, before);
});

test("PNG validation rejects trailing bytes, truncation and non-PNG payloads", async () => {
  const png = await sharp({
    create: { width: 2, height: 2, channels: 4, background: "#147a68" },
  })
    .png()
    .toBuffer();
  await assert.rejects(
    validatePng(Buffer.concat([png, Buffer.from("extra")])),
    code("invalid_png"),
  );
  await assert.rejects(
    validatePng(png.subarray(0, png.length - 5)),
    code("invalid_png"),
  );
  await assert.rejects(validatePng(Buffer.from("<svg/>")), code("invalid_png"));
});

test("pair validation binds the manifest to both exact files and image dimensions", async () => {
  const json = bytes(document());
  const png = await sharp({
    create: { width: 2, height: 3, channels: 4, background: "#147a68" },
  })
    .png()
    .toBuffer();
  const result = await validatePair(json, png);
  const manifest: MapManifest = {
    schema_version: 1,
    editor: result.document.format,
    map_revision: result.revision,
    base_map_revision: null,
    base_commit_sha: null,
    operation_id: "bootstrap-test",
    contributor_display_name: "Test",
    summary: "Fixture",
    selected_issue_numbers: [],
    created_at: "2026-10-06T00:00:00Z",
    files: {
      json: {
        path: "maps/network.json",
        sha256: result.jsonHash,
        bytes: json.length,
      },
      png: {
        path: "maps/network.png",
        sha256: result.pngHash,
        bytes: png.length,
        width: 2,
        height: 3,
      },
    },
  };
  assert.deepEqual(parseManifest(bytes(manifest)), manifest);
  await assert.rejects(
    validatePair(Buffer.concat([json, Buffer.from("\n")]), png, manifest),
    code("manifest_checksum_mismatch"),
  );
  await assert.rejects(
    validatePair(json, png, {
      ...manifest,
      files: { ...manifest.files, png: { ...manifest.files.png, width: 3 } },
    }),
    code("manifest_checksum_mismatch"),
  );
  assert.notEqual(
    mapRevision(result.jsonHash, result.pngHash),
    mapRevision(result.pngHash, result.jsonHash),
  );
});
