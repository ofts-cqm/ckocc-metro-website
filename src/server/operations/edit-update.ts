import { query } from "@/server/db";
import { MAP_PATHS, repositoryConfig } from "@/server/github/client";
import { assertEligibleIssue } from "@/server/github/issues";
import { pullRequestTemplate } from "@/server/github/templates";
import { assertFresh } from "@/server/maps/sessions";
import { validatePair, type MapManifest } from "@/server/maps/validate";
import { readStaged, uploadRecord } from "@/server/storage/staging";
import { checkpoint, type Operation } from "./store";
import {
  requireOperationAdmin,
  websitePullRequest,
  readValidatedMap,
} from "./map-actions";
import { PipelineError } from "./errors";
import type { UpdateInput } from "./update";

/** Applies an author edit to the existing website pull request using staged map files.
 * The update edit action queues this worker after the edit session is submitted. */
export async function processEditUpdate(action: Operation, token: string) {
  await requireOperationAdmin(action);
  const input = action.payload as UpdateInput & {
    updateId: string;
    headSha: string;
  };
  let commitSha = action.checkpoint.editCommit as string | undefined;
  const {
    op: source,
    pr,
    client,
  } = await websitePullRequest(input.updateId, commitSha);
  const { owner, repo } = repositoryConfig();
  const ref = `heads/${pr.head.ref}`;
  /** Reads the live PR branch head to reconcile uncertain edit writes. */
  const observe = async () =>
    (await client.rest.git.getRef({ owner, repo, ref })).data.object.sha;
  /** Stores the edited PR commit and metadata on the source update. */
  const record = async () => {
    const manifest = action.checkpoint.editManifest as MapManifest;
    if (!manifest || !commitSha)
      throw new PipelineError("outcome_unknown", 409);
    // Retain the original contributor and edit base; the separate action records the editor.
    const updated = await query(
      `UPDATE metro_operations SET payload=payload||$3::jsonb,checkpoint=checkpoint||$4::jsonb,
       result=result||$5::jsonb,updated_at=now() WHERE id=$1 AND checkpoint->>'commitSha'=$2 RETURNING id`,
      [
        source.id,
        input.headSha,
        JSON.stringify({
          summary: input.summary,
          details: input.details,
          issueNumbers: input.issueNumbers,
        }),
        JSON.stringify({
          originalCommitSha:
            source.checkpoint.originalCommitSha ?? input.headSha,
          commitSha,
          mapRevision: manifest.map_revision,
          manifest,
          lastEditOperationId: action.id,
        }),
        JSON.stringify({ commitSha, mapRevision: manifest.map_revision }),
      ],
    );
    if (!updated.rowCount && source.checkpoint.commitSha !== commitSha)
      throw new PipelineError("outcome_unknown", 409);
    return {
      prNumber: pr.number,
      prUrl: pr.html_url,
      commitSha,
      mapRevision: manifest.map_revision,
    };
  };
  /** Aligns PR metadata after the branch update and completes the action. */
  const finish = async () => {
    const manifest = action.checkpoint.editManifest as MapManifest;
    const body = pullRequestTemplate(manifest, input.details);
    const title = `Map update: ${input.summary.replace(/[@#]/g, "")}`;
    const fresh = await websitePullRequest(source.id, commitSha);
    if (fresh.pr.body !== body || fresh.pr.title !== title) {
      if (action.checkpoint.editMetadataIntent)
        throw new PipelineError("outcome_unknown", 409);
      if (fresh.pr.merged || fresh.pr.state !== "open")
        throw new PipelineError("pr_closed", 409);
      await requireOperationAdmin(action);
      await checkpoint(action.id, token, { editMetadataIntent: true });
      await client.rest.pulls.update({
        owner,
        repo,
        pull_number: pr.number,
        title,
        body,
      });
      const observed = await websitePullRequest(source.id, commitSha);
      if (observed.pr.body !== body || observed.pr.title !== title)
        throw new PipelineError("outcome_unknown", 409);
    }
    return record();
  };
  // Recover a completed branch move, or stop when its result is uncertain.
  if (commitSha && (await observe()) === commitSha) return finish();
  if (action.checkpoint.editIntent)
    throw new PipelineError("outcome_unknown", 409);
  if (source.checkpoint.deletedAt || pr.merged || pr.state !== "open")
    throw new PipelineError("pr_closed", 409);
  if (
    pr.head.sha !== input.headSha ||
    source.checkpoint.amendEditSessionId !== input.editSessionId ||
    input.baseCommit !== source.payload.baseCommit ||
    input.baseMapRevision !== source.payload.baseMapRevision
  )
    throw new PipelineError("pr_identity_changed", 409);
  await assertFresh(input.baseMapRevision);
  for (const number of input.issueNumbers)
    await assertEligibleIssue(number, true);
  // Validate staged files and build the replacement commit.
  if (!commitSha) {
    await checkpoint(action.id, token, {
      previousPayload: source.payload,
      previousManifest: source.checkpoint.manifest ?? null,
    });
    const uploads = await Promise.all([
      uploadRecord(input.jsonUploadId),
      uploadRecord(input.pngUploadId),
    ]);
    if (
      uploads.some(
        (u) =>
          u.owner_id !== action.actor_id ||
          u.edit_session_id !== input.editSessionId ||
          u.status !== "ready",
      ) ||
      uploads[0].kind !== "json" ||
      uploads[1].kind !== "png"
    )
      throw new PipelineError("invalid_upload");
    const [json, png] = await Promise.all(uploads.map(readStaged));
    const validation = await validatePair(json, png);
    if (validation.revision === input.baseMapRevision)
      throw new PipelineError("unchanged_map", 409);
    const original = await readValidatedMap(input.headSha);
    if (
      original.manifest.operation_id !== source.id ||
      original.manifest.base_commit_sha !== input.baseCommit ||
      original.manifest.base_map_revision !== input.baseMapRevision
    )
      throw new PipelineError("pr_identity_changed", 409);
    const manifest: MapManifest = {
      ...original.manifest,
      summary: input.summary,
      selected_issue_numbers: input.issueNumbers,
      map_revision: validation.revision,
      editor: validation.document.format,
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
    const blobs = await Promise.all(
      [json, png, Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`)].map(
        (bytes) =>
          client.rest.git.createBlob({
            owner,
            repo,
            content: bytes.toString("base64"),
            encoding: "base64",
          }),
      ),
    );
    const parent = await client.rest.git.getCommit({
      owner,
      repo,
      commit_sha: input.headSha,
    });
    const tree = await client.rest.git.createTree({
      owner,
      repo,
      base_tree: parent.data.tree.sha,
      tree: Object.values(MAP_PATHS).map((path, i) => ({
        path,
        mode: "100644",
        type: "blob",
        sha: blobs[i].data.sha,
      })),
    });
    const author = {
      name: "CKOCC Metro Bot",
      email: "metro-bot@users.noreply.github.com",
      date: new Date(action.created_at).toISOString(),
    };
    const commit = await client.rest.git.createCommit({
      owner,
      repo,
      tree: tree.data.sha,
      parents: [input.headSha],
      message: `Edit map update ${action.id}`,
      author,
      committer: author,
    });
    commitSha = commit.data.sha;
    await checkpoint(action.id, token, {
      editCommit: commitSha,
      editManifest: manifest,
    });
    action.checkpoint.editManifest = manifest;
  }
  // Recheck the live PR after building the replacement commit.
  const fresh = await websitePullRequest(source.id);
  if (
    fresh.pr.merged ||
    fresh.pr.state !== "open" ||
    fresh.pr.head.sha !== input.headSha
  )
    throw new PipelineError("pr_identity_changed", 409);
  await assertFresh(input.baseMapRevision);
  await requireOperationAdmin(action);
  // Record ref update intent before moving the PR branch.
  await checkpoint(action.id, token, { editIntent: true });
  await client.rest.git.updateRef({
    owner,
    repo,
    ref,
    sha: commitSha,
    force: false,
  });
  if ((await observe()) !== commitSha)
    throw new PipelineError("outcome_unknown", 409);
  return finish();
}
