import { query } from "@/server/db";
import { getActiveCollaborator } from "@/server/auth/authorize";
import {
  github,
  repositoryConfig,
  MAP_PATHS,
  expectedBotLogin,
} from "@/server/github/client";
import { assertEligibleIssue } from "@/server/github/issues";
import { pullRequestTemplate } from "@/server/github/templates";
import { assertFresh } from "@/server/maps/sessions";
import { validatePair, type MapManifest } from "@/server/maps/validate";
import { uploadRecord, readStaged } from "@/server/storage/staging";
import { checkpoint, type Operation } from "./store";
import { PipelineError, statusOf } from "./errors";
import { readValidatedMap, requireOperationAdmin } from "./map-actions";
import { resolveMapBase } from "@/server/maps/sessions";

export interface UpdateInput extends Record<string, unknown> {
  editSessionId: string;
  summary: string;
  details: string;
  issueNumbers: number[];
  jsonUploadId: string;
  pngUploadId: string;
  baseCommit: string;
  baseMapRevision: string;
}

export async function processUpdate(op: Operation, leaseToken: string) {
  if (!op.actor_id) throw new PipelineError("unauthorized", 401);
  const user =
    op.kind === "rollback"
      ? await requireOperationAdmin(op)
      : await getActiveCollaborator(op.actor_id);
  if (!user) throw new PipelineError("unauthorized", 401);
  const input = op.payload as UpdateInput;
  const client = await github();
  const { owner, repo, branch } = repositoryConfig();
  expectedBotLogin();
  const head = `metro-update/${op.id}`;
  const existing = await client.rest.pulls.list({
    owner,
    repo,
    head: `${owner}:${head}`,
    base: branch,
    state: "all",
    per_page: 100,
  });
  if (existing.data.length) {
    if (
      existing.data.length !== 1 ||
      existing.data[0].user?.login !== expectedBotLogin() ||
      !existing.data[0].body?.includes(`<!-- metro-operation:${op.id} -->`) ||
      (op.checkpoint.commitSha &&
        existing.data[0].head.sha !== op.checkpoint.commitSha)
    )
      throw new PipelineError("outcome_unknown", 409);
    return {
      prNumber: existing.data[0].number,
      prUrl: existing.data[0].html_url,
      branch: head,
      commitSha: existing.data[0].head.sha,
      mapRevision: op.checkpoint.mapRevision,
    };
  }
  if (op.checkpoint.prIntent) throw new PipelineError("outcome_unknown", 409);
  await checkpoint(op.id, leaseToken, {}, "validating");
  await assertFresh(input.baseMapRevision);
  let json: Buffer, png: Buffer;
  if (op.kind === "rollback") {
    const approved = await resolveMapBase(String(op.payload.restoreCommit));
    const restored = await readValidatedMap(approved.commit);
    if (restored.manifest.map_revision !== op.payload.restoreRevision)
      throw new PipelineError("historical_map_mismatch", 409);
    ({ json, png } = restored);
    if (input.issueNumbers.length)
      throw new PipelineError("invalid_rollback", 409);
  } else {
    const uploads = await Promise.all([
      uploadRecord(input.jsonUploadId),
      uploadRecord(input.pngUploadId),
    ]);
    if (
      uploads.some(
        (u) =>
          u.owner_id !== op.actor_id ||
          u.edit_session_id !== input.editSessionId ||
          u.status !== "ready",
      ) ||
      uploads[0].kind !== "json" ||
      uploads[1].kind !== "png"
    )
      throw new PipelineError("invalid_upload");
    [json, png] = await Promise.all(uploads.map(readStaged));
  }
  const validation = await validatePair(json, png);
  if (validation.revision === input.baseMapRevision)
    throw new PipelineError("unchanged_map", 409);
  for (const number of input.issueNumbers)
    await assertEligibleIssue(number, true);
  const manifest: MapManifest = {
    schema_version: 1,
    editor: validation.document.format,
    map_revision: validation.revision,
    base_map_revision: input.baseMapRevision,
    base_commit_sha: input.baseCommit,
    operation_id: op.id,
    contributor_display_name: user.name,
    summary: input.summary,
    selected_issue_numbers: input.issueNumbers,
    created_at: new Date(op.created_at).toISOString(),
    files: {
      json: {
        path: MAP_PATHS.json,
        sha256: validation.jsonHash,
        bytes: json.length,
      },
      png: {
        path: MAP_PATHS.png,
        sha256: validation.pngHash,
        bytes: png.length,
        width: validation.image.width,
        height: validation.image.height,
      },
    },
  };
  // Pin author/manifest text before object creation so a profile rename cannot change a retry.
  const pinnedManifest =
    (op.checkpoint.manifest as MapManifest | undefined) ?? manifest;
  if (
    pinnedManifest.map_revision !== validation.revision ||
    pinnedManifest.files.json.sha256 !== validation.jsonHash ||
    pinnedManifest.files.png.sha256 !== validation.pngHash
  )
    throw new PipelineError("staged_files_changed", 409);
  await checkpoint(
    op.id,
    leaseToken,
    { manifest: pinnedManifest, mapRevision: validation.revision },
    "creating_pr",
  );
  let commitSha = op.checkpoint.commitSha as string | undefined;
  if (!commitSha) {
    // Keep the recorded edit base in the manifest; choose a current parent when
    // only maintenance has advanced main. This does not merge map documents.
    const parentCommit =
      (op.checkpoint.prParentCommit as string | undefined) ??
      (await assertFresh(input.baseMapRevision)).commit;
    if (!op.checkpoint.prParentCommit)
      await checkpoint(op.id, leaseToken, { prParentCommit: parentCommit });
    if (op.kind === "rollback") await requireOperationAdmin(op);
    const blobs = await Promise.all([
      client.rest.git.createBlob({
        owner,
        repo,
        content: json.toString("base64"),
        encoding: "base64",
      }),
      client.rest.git.createBlob({
        owner,
        repo,
        content: png.toString("base64"),
        encoding: "base64",
      }),
      client.rest.git.createBlob({
        owner,
        repo,
        content: `${JSON.stringify(pinnedManifest, null, 2)}\n`,
        encoding: "utf-8",
      }),
    ]);
    const base = await client.rest.git.getCommit({
      owner,
      repo,
      commit_sha: parentCommit,
    });
    const tree = await client.rest.git.createTree({
      owner,
      repo,
      base_tree: base.data.tree.sha,
      tree: [MAP_PATHS.json, MAP_PATHS.png, MAP_PATHS.manifest].map(
        (path, i) => ({
          path,
          mode: "100644",
          type: "blob",
          sha: blobs[i].data.sha,
        }),
      ),
    });
    const author = {
      name: "CKOCC Metro Bot",
      email: "metro-bot@users.noreply.github.com",
      date: new Date(op.created_at).toISOString(),
    };
    const commit = await client.rest.git.createCommit({
      owner,
      repo,
      tree: tree.data.sha,
      parents: [parentCommit],
      message: `Map update ${op.id}`,
      author,
      committer: author,
    });
    commitSha = commit.data.sha;
    await checkpoint(op.id, leaseToken, { commitSha });
  }
  await assertFresh(input.baseMapRevision);
  if (op.kind === "rollback") await requireOperationAdmin(op);
  if (!(await getActiveCollaborator(op.actor_id)))
    throw new PipelineError("unauthorized", 401);
  await checkpoint(op.id, leaseToken, { branchIntent: true });
  try {
    const ref = await client.rest.git.getRef({
      owner,
      repo,
      ref: `heads/${head}`,
    });
    if (ref.data.object.sha !== commitSha)
      throw new PipelineError("branch_conflict", 409);
  } catch (error) {
    if (statusOf(error) !== 404) throw error;
    await client.rest.git.createRef({
      owner,
      repo,
      ref: `refs/heads/${head}`,
      sha: commitSha,
    });
  }
  // Check again immediately before the only PR-creation attempt.
  await assertFresh(input.baseMapRevision);
  if (op.kind === "rollback") await requireOperationAdmin(op);
  await checkpoint(op.id, leaseToken, { prIntent: true, branch: head });
  const pr = await client.rest.pulls.create({
    owner,
    repo,
    head,
    base: branch,
    title: `Map update: ${input.summary.replace(/[@#]/g, "")}`,
    body: pullRequestTemplate(pinnedManifest, input.details),
  });
  const result = {
    prNumber: pr.data.number,
    prUrl: pr.data.html_url,
    branch: head,
    commitSha,
    mapRevision: validation.revision,
  };
  await checkpoint(op.id, leaseToken, { prResult: result });
  if (op.kind === "update")
    await query(
      "UPDATE metro_edit_sessions SET status='submitted' WHERE id=$1",
      [input.editSessionId],
    );
  return result;
}
