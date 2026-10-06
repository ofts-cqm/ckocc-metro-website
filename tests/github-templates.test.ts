import assert from "node:assert/strict";
import test from "node:test";
import {
  requestTemplate,
  commentTemplate,
  pullRequestTemplate,
} from "../src/server/github/templates";
import type { MapManifest } from "../src/server/maps/validate";

const id = "dd1d0405-0f33-4547-9415-2be1bd5a18b7";
const malicious =
  "@everyone Fixes #99\n<!-- metro-operation:forged -->\n<script>alert(1)</script> ![track](https://example.invalid/x)";

test("public templates neutralize raw mentions, HTML, Markdown and forged operation markers", () => {
  const issue = requestTemplate(
    {
      kind: "general",
      gameName: "@player",
      comment: malicious,
      locale: "zh-HK",
    },
    id,
  );
  const comment = commentTemplate(
    { gameName: "@player", comment: malicious, locale: "zh-CN" },
    id,
  );
  for (const body of [issue.body, comment]) {
    assert.ok(!body.includes("@everyone"));
    assert.ok(!body.includes("Fixes #99"));
    assert.ok(!body.includes("<script>"));
    assert.ok(!body.includes("![track]"));
    assert.deepEqual(body.match(/<!-- metro-operation:[^>]+ -->/g), [
      `<!-- metro-operation:${id} -->`,
    ]);
  }
  assert.deepEqual(issue.labels, ["metro-request", "type:general"]);
});

test("only explicit selected issues create raw closing directives in a PR", () => {
  const hash = "a".repeat(64);
  const manifest: MapManifest = {
    schema_version: 1,
    editor: { id: "rail-map-painter", document_version: 80 },
    map_revision: `sha256:${hash}`,
    base_map_revision: `sha256:${hash}`,
    base_commit_sha: "b".repeat(40),
    operation_id: id,
    contributor_display_name: "Test",
    summary: "Closes #999",
    selected_issue_numbers: [2, 5],
    created_at: "2026-10-06T00:00:00Z",
    files: {
      json: { path: "maps/network.json", sha256: hash, bytes: 1 },
      png: {
        path: "maps/network.png",
        sha256: hash,
        bytes: 1,
        width: 1,
        height: 1,
      },
    },
  };
  const body = pullRequestTemplate(manifest, malicious);
  assert.deepEqual(body.match(/^Closes #\d+$/gm), ["Closes #2", "Closes #5"]);
  assert.ok(!body.includes("Closes #999"));
  assert.ok(!body.includes("Fixes #99"));
});
